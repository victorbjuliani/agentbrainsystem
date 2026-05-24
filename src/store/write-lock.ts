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
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

/**
 * Create/take the rebuild lock for this process. Always succeeds (advisory, not
 * mandatory): it stamps the lockfile so other processes defer. Caller MUST
 * `release()` in a finally and `heartbeat()` periodically while working.
 */
export function acquireRebuildLock(dbPath: string): RebuildLock {
  const path = rebuildLockPath(dbPath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch {
    // A lock we couldn't write just means peers won't defer — never block on it.
  }
  return {
    heartbeat() {
      try {
        const now = new Date();
        utimesSync(path, now, now);
      } catch {
        // Lost lockfile mid-run → readers fall back to the TTL/stale path. Non-fatal.
      }
    },
    release() {
      try {
        rmSync(path, { force: true });
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
