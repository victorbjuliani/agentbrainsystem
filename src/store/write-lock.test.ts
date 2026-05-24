import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireRebuildLock,
  isRebuildLocked,
  REBUILD_LOCK_TTL_MS,
  rebuildLockPath,
} from './write-lock.js';

describe('write-lock — cross-process advisory single-writer lock (#103)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-lock-'));
    dbPath = join(dir, 'memory.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('puts the lockfile alongside the db', () => {
    expect(dirname(rebuildLockPath(dbPath))).toBe(dir);
    expect(rebuildLockPath(dbPath)).toMatch(/\.rebuild\.lock$/);
  });

  it('is unlocked before acquire, locked after, unlocked after release', () => {
    expect(isRebuildLocked(dbPath)).toBe(false);
    const lock = acquireRebuildLock(dbPath);
    expect(isRebuildLocked(dbPath)).toBe(true);
    expect(existsSync(rebuildLockPath(dbPath))).toBe(true);
    lock.release();
    expect(isRebuildLocked(dbPath)).toBe(false);
    expect(existsSync(rebuildLockPath(dbPath))).toBe(false);
  });

  it('treats a lockfile older than the TTL as stale (dead holder) → not locked', () => {
    acquireRebuildLock(dbPath);
    const path = rebuildLockPath(dbPath);
    // Age the lockfile well past the TTL — simulates a holder that crashed without
    // releasing and stopped heartbeating.
    const old = (Date.now() - REBUILD_LOCK_TTL_MS - 5000) / 1000;
    utimesSync(path, old, old);
    expect(isRebuildLocked(dbPath)).toBe(false);
  });

  it('heartbeat refreshes the mtime so the lock stays held', () => {
    const lock = acquireRebuildLock(dbPath);
    const path = rebuildLockPath(dbPath);
    const old = (Date.now() - REBUILD_LOCK_TTL_MS - 5000) / 1000;
    utimesSync(path, old, old);
    expect(isRebuildLocked(dbPath)).toBe(false); // gone stale
    lock.heartbeat();
    expect(isRebuildLocked(dbPath)).toBe(true); // refreshed → held again
    lock.release();
  });

  it('is exclusive: a second acquire does not own the lock and cannot release a peer (#103, Codex P1)', () => {
    const a = acquireRebuildLock(dbPath); // owns (atomic create)
    const b = acquireRebuildLock(dbPath); // fresh lock exists → b does NOT own it
    // b releasing must NOT remove a's live lock.
    b.release();
    expect(isRebuildLocked(dbPath)).toBe(true);
    // a still owns and can release it.
    a.release();
    expect(isRebuildLocked(dbPath)).toBe(false);
  });

  it('steals a STALE lock so a dead holder cannot wedge writers forever', () => {
    acquireRebuildLock(dbPath); // first holder
    const path = rebuildLockPath(dbPath);
    const old = (Date.now() - REBUILD_LOCK_TTL_MS - 5000) / 1000;
    utimesSync(path, old, old); // simulate the holder dying without releasing
    const b = acquireRebuildLock(dbPath); // stale → b steals it
    expect(isRebuildLocked(dbPath)).toBe(true);
    b.release(); // b owns the stolen lock → release clears it
    expect(isRebuildLocked(dbPath)).toBe(false);
  });

  it('release is idempotent and safe when no lock exists', () => {
    const lock = acquireRebuildLock(dbPath);
    lock.release();
    expect(() => lock.release()).not.toThrow();
    expect(isRebuildLocked(dbPath)).toBe(false);
  });
});
