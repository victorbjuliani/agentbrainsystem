// src/store/concurrency.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store.js';

const DIM = 8;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-concurrency-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('store durability pragmas', () => {
  it('opens the db in WAL mode (persisted, observable from a second connection)', () => {
    const dbPath = join(dir, 'memory.db');
    const store = new MemoryStore({ dbPath, dimensions: DIM });
    store.open();
    store.setMeta('k:a', '1');
    expect(store.getMeta('k:a')).toBe('1');
    store.close();

    const probe = new Database(dbPath);
    const mode = (probe.pragma('journal_mode', { simple: true }) as string).toLowerCase();
    probe.close();
    expect(mode).toBe('wal');
  });
});
