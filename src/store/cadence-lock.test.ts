import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireCadenceLock, CADENCE_LOCK_TTL_MS, cadenceLockPath } from './cadence-lock.js';

describe('cadence-lock — dedicated cadence-vs-cadence advisory lock (#138 C3)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-cadence-lock-'));
    dbPath = join(dir, 'memory.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('puts a SEPARATE .cadence.lock file alongside the db (not .rebuild.lock)', () => {
    expect(dirname(cadenceLockPath(dbPath))).toBe(dir);
    expect(cadenceLockPath(dbPath)).toMatch(/\.cadence\.lock$/);
    expect(cadenceLockPath(dbPath)).not.toMatch(/\.rebuild\.lock$/);
  });

  it('acquires on a clean dir → { acquired: true }', () => {
    const lock = acquireCadenceLock(dbPath);
    expect(lock.acquired).toBe(true);
    expect(existsSync(cadenceLockPath(dbPath))).toBe(true);
    lock.release();
  });

  it('uses a filesystem-safe token — no colon in the steal scratch name (Windows, PR #168)', () => {
    const lock = acquireCadenceLock(dbPath);
    expect(lock.acquired).toBe(true);
    const { token } = JSON.parse(readFileSync(cadenceLockPath(dbPath), 'utf8')) as {
      token: string;
    };
    // The token is embedded in `.dead-${token}`; `:` is invalid on Windows. pid-uuid only.
    expect(token).not.toContain(':');
    expect(token).toMatch(/^\d+-[0-9a-f-]+$/i);
    lock.release();
  });

  it('a SECOND concurrent acquire (before release) does NOT own → { acquired: false }', () => {
    const a = acquireCadenceLock(dbPath); // wins the atomic create
    const b = acquireCadenceLock(dbPath); // fresh lock exists → EEXIST, not stale
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(false);
    // b must not be able to release a's live lock.
    b.release();
    expect(existsSync(cadenceLockPath(dbPath))).toBe(true);
    a.release();
    expect(existsSync(cadenceLockPath(dbPath))).toBe(false);
  });

  it('after release, a fresh acquire wins again → { acquired: true }', () => {
    const a = acquireCadenceLock(dbPath);
    a.release();
    const b = acquireCadenceLock(dbPath);
    expect(b.acquired).toBe(true);
    b.release();
  });

  it('steals a STALE lockfile (mtime past the TTL → dead holder) → { acquired: true }', () => {
    acquireCadenceLock(dbPath); // first holder, then "dies" without releasing
    const path = cadenceLockPath(dbPath);
    const old = (Date.now() - CADENCE_LOCK_TTL_MS - 5000) / 1000;
    utimesSync(path, old, old);
    const b = acquireCadenceLock(dbPath); // stale → b steals it
    expect(b.acquired).toBe(true);
    b.release();
    expect(existsSync(path)).toBe(false);
  });

  it('heartbeat refreshes the mtime so the lock stays held', () => {
    const lock = acquireCadenceLock(dbPath);
    const path = cadenceLockPath(dbPath);
    const old = (Date.now() - CADENCE_LOCK_TTL_MS - 5000) / 1000;
    utimesSync(path, old, old);
    const beforeBeat = statSync(path).mtimeMs;
    lock.heartbeat();
    expect(statSync(path).mtimeMs).toBeGreaterThan(beforeBeat);
    lock.release();
  });

  it('release is idempotent and only removes OUR lockfile', () => {
    const lock = acquireCadenceLock(dbPath);
    lock.release();
    expect(() => lock.release()).not.toThrow();
    expect(existsSync(cadenceLockPath(dbPath))).toBe(false);
  });

  it('heartbeat/release are no-ops when !acquired (never touch a peer lock)', () => {
    const a = acquireCadenceLock(dbPath); // owner
    const b = acquireCadenceLock(dbPath); // !acquired
    expect(b.acquired).toBe(false);
    // A non-owner heartbeat/release must not affect the owner's lockfile.
    expect(() => b.heartbeat()).not.toThrow();
    expect(() => b.release()).not.toThrow();
    expect(existsSync(cadenceLockPath(dbPath))).toBe(true);
    a.release();
  });
});
