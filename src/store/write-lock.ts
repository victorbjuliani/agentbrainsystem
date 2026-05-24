/**
 * Cross-process advisory single-writer lock (#103).
 *
 * The MCP stdio server runs a background full index rebuild that re-embeds every
 * observation, holding the SQLite write-lock in bursts. A concurrent hook process
 * (`abs hook session-end` ingest) would otherwise block on that lock until
 * `busy_timeout` (5s) and then fail-open silently — losing the just-finished
 * session's memory with no signal. This file-based advisory lock lets the hook
 * SEE that a rebuild is in flight and defer gracefully (log + recoverable) instead
 * of racing into a silent timeout.
 *
 * Crash-safe by TTL: the holder heartbeats the lockfile's mtime while it works; a
 * reader treats a lockfile older than the TTL as stale (the holder died) and
 * proceeds. This is deliberately NOT distributed locking — single user, one MCP +
 * hooks + the occasional CLI (ADR-0001 ergonomics).
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** A lock older than this (no heartbeat) is treated as a dead holder and ignored. */
export const REBUILD_LOCK_TTL_MS = 15_000;

/** How often the holder should refresh the lockfile mtime — well inside the TTL. */
export const REBUILD_HEARTBEAT_MS = 3_000;

/** kv_meta key: when set, a background rebuild failed and recall is degraded (#101 surfaces it). */
export const REBUILD_FAILED_KEY = 'index:rebuild_failed_at';

/** kv_meta key: when set, an ingest was deferred because a rebuild held the write lock. */
export const INGEST_DEFERRED_KEY = 'ingest:deferred_at';

export interface RebuildLock {
  /** Refresh the lockfile mtime so readers keep seeing the lock as held. */
  heartbeat(): void;
  /** Remove the lockfile. Idempotent and best-effort. */
  release(): void;
}

/** Path of the advisory lockfile, alongside the db file. */
export function rebuildLockPath(dbPath: string): string {
  return join(dirname(dbPath), '.rebuild.lock');
}

/** Does the lockfile currently carry OUR ownership token? */
function ownsLock(path: string, token: string): boolean {
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { token?: string }).token === token;
  } catch {
    return false;
  }
}

/**
 * Take the rebuild lock for this process. Acquisition is EXCLUSIVE: the lockfile is
 * created atomically (`wx`), so two processes can't both believe they hold it. If a
 * fresh lock already exists, this process does NOT own it (heartbeat/release become
 * no-ops) — it must not delete a peer's live lock out from under it. A STALE lock
 * (holder died, no heartbeat past the TTL) is stolen.
 *
 * Always returns a handle (advisory, never throws). Caller MUST `release()` in a
 * finally and `heartbeat()` periodically while working.
 */
export function acquireRebuildLock(dbPath: string): RebuildLock {
  const path = rebuildLockPath(dbPath);
  const token = `${process.pid}:${randomUUID()}`;
  const payload = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() });
  let owns = false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, payload, { flag: 'wx' }); // atomic create — EEXIST if held
      owns = true;
    } catch {
      // A lock already exists. Steal it ONLY if it is stale (dead holder); never
      // clobber a peer's fresh lock — that is exactly the double-owner bug.
      if (!isRebuildLocked(dbPath)) {
        try {
          writeFileSync(path, payload);
          owns = true;
        } catch {
          owns = false;
        }
      }
    }
  } catch {
    owns = false; // couldn't even mkdir — peers just won't defer; never block.
  }
  return {
    heartbeat() {
      if (!owns) return;
      try {
        if (ownsLock(path, token)) {
          const now = new Date();
          utimesSync(path, now, now);
        }
      } catch {
        // Lost lockfile mid-run → readers fall back to the TTL/stale path. Non-fatal.
      }
    },
    release() {
      // Only remove the lockfile if WE still own it — never delete a peer's lock.
      if (!owns) return;
      try {
        if (ownsLock(path, token)) rmSync(path, { force: true });
      } catch {
        // Stale lockfile is harmless — it ages out via the TTL.
      }
    },
  };
}

/**
 * Whether a FRESH rebuild lock is currently held by some process. A lockfile older
 * than `ttlMs` (the holder stopped heartbeating — crashed) reads as NOT locked so a
 * dead holder can never wedge ingest forever.
 */
export function isRebuildLocked(dbPath: string, ttlMs = REBUILD_LOCK_TTL_MS): boolean {
  const path = rebuildLockPath(dbPath);
  try {
    if (!existsSync(path)) return false;
    return Date.now() - statSync(path).mtimeMs < ttlMs;
  } catch {
    return false;
  }
}
