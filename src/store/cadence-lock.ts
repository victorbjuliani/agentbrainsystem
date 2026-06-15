/**
 * Dedicated cadence advisory lock (#138 C3).
 *
 * The auto-distill cadence (`abs maintain --auto`) is spawned detached at every
 * qualifying SessionEnd, so two near-simultaneous sessions could both fire a
 * cadence and double-bill the consolidate LLM call. This lock serializes
 * cadence-vs-cadence ONLY — it is a SEPARATE `.cadence.lock` file, NOT the rebuild
 * lock (`write-lock.ts`): reusing the rebuild lock would force every concurrent
 * SessionEnd ingest to defer for the whole consolidate+optimize run (seconds). The
 * cadence's own SQLite writes go through the normal WAL/`busy_timeout` path like any
 * other writer; this advisory lock guards only the LLM-spend window.
 *
 * Faithful sibling of `acquireRebuildLock` with ONE deliberate contract difference:
 * the acquire RETURNS OWNERSHIP atomically from the `wx` create (`{ acquired }`),
 * with NO pre-acquire `isLocked` read. A pre-read is itself a TOCTOU (two SessionEnds
 * could both read "unlocked" then both acquire) and is forbidden as the guard. The
 * caller gates the run on `acquired`: false ⇒ another cadence owns it, exit no-op.
 *
 * Crash-safe by TTL: the holder heartbeats the lockfile mtime across a slow LLM call;
 * a lockfile older than the TTL reads as a dead holder and is stolen.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** A cadence lock older than this (no heartbeat) is treated as a dead holder and stolen. */
export const CADENCE_LOCK_TTL_MS = 15_000;

/** How often the cadence holder should refresh the lockfile mtime — well inside the TTL. */
export const CADENCE_HEARTBEAT_MS = 3_000;

export interface CadenceLock {
  /** True IFF this process won the atomic create (or stole a stale lock). */
  acquired: boolean;
  /** Refresh the lockfile mtime so peers keep seeing the lock as held. No-op when !acquired. */
  heartbeat(): void;
  /** Remove the lockfile. Idempotent, best-effort, no-op when !acquired. */
  release(): void;
}

/** Path of the cadence lockfile, alongside the db file (SEPARATE from `.rebuild.lock`). */
export function cadenceLockPath(dbPath: string): string {
  return join(dirname(dbPath), '.cadence.lock');
}

/** Does the lockfile currently carry OUR ownership token? */
function ownsLock(path: string, token: string): boolean {
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { token?: string }).token === token;
  } catch {
    return false;
  }
}

/** Is the existing lockfile stale (no heartbeat past the TTL → the holder died)? */
function isStale(path: string, ttlMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs >= ttlMs;
  } catch {
    // Vanished between EEXIST and the stat — treat as free (a fresh create will retry).
    return true;
  }
}

/**
 * Take the cadence lock for this process. Acquisition is EXCLUSIVE and atomic: the
 * lockfile is created with `wx`, so two cadences can't both believe they hold it.
 * `acquired` is computed SOLELY from that create outcome (and the stale-steal) — there
 * is NO separate `isLocked` read (that pre-read is the forbidden TOCTOU). On EEXIST we
 * steal ONLY if the existing lock is stale (dead holder); otherwise `acquired:false`.
 *
 * Always returns a handle (advisory, never throws). Gate the run on `acquired`; the
 * caller MUST `release()` in a finally and `heartbeat()` periodically while working.
 */
export function acquireCadenceLock(dbPath: string): CadenceLock {
  const path = cadenceLockPath(dbPath);
  const token = `${process.pid}:${randomUUID()}`;
  const payload = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() });
  let acquired = false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, payload, { flag: 'wx' }); // atomic create — EEXIST if held
      acquired = true;
    } catch {
      // A lock already exists. Steal it ONLY if it is stale (dead holder); never
      // clobber a peer's fresh lock — that is the double-owner bug. The steal must be
      // ATOMIC (#138 RC-002): a plain `writeFileSync(w)` after `isStale` is a TOCTOU —
      // two processes could both pass `isStale` and both overwrite, double-owning. Instead
      // rename the stale lock to a unique name, then recreate with `wx`: `rename(2)` over
      // the SAME source path serializes in the kernel, so only ONE racer moves that inode;
      // the loser's rename throws (source already gone) and it stays unacquired.
      if (isStale(path, CADENCE_LOCK_TTL_MS)) {
        const dead = `${path}.dead-${token}`;
        try {
          renameSync(path, dead); // only one concurrent steal wins this move
          writeFileSync(path, payload, { flag: 'wx' }); // recreate exclusively
          rmSync(dead, { force: true });
          acquired = true;
        } catch {
          rmSync(dead, { force: true }); // best-effort cleanup if we lost mid-steal
          acquired = false;
        }
      }
    }
  } catch {
    acquired = false; // couldn't even mkdir — never block; the run just exits no-op.
  }
  return {
    acquired,
    heartbeat() {
      if (!acquired) return;
      try {
        if (ownsLock(path, token)) {
          const now = new Date();
          utimesSync(path, now, now);
        }
      } catch {
        // Lost lockfile mid-run → peers fall back to the TTL/stale path. Non-fatal.
      }
    },
    release() {
      // Only remove the lockfile if WE still own it — never delete a peer's lock.
      if (!acquired) return;
      try {
        if (existsSync(path) && ownsLock(path, token)) rmSync(path, { force: true });
      } catch {
        // Stale lockfile is harmless — it ages out via the TTL.
      }
    },
  };
}
