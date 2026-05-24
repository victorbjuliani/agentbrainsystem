import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSymbolStore, type SymbolStore } from './symbol-store.js';

describe('SymbolStore', () => {
  let home: string;
  let store: SymbolStore;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'abs-idx-'));
    process.env.ABS_HOME = home;
    store = openSymbolStore('/repo/root');
  });
  afterEach(() => {
    store.close();
    delete process.env.ABS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("upserts a file's defs and queries by name", () => {
    store.upsertFile('a.ts', [{ name: 'foo', kind: 'function_declaration', line: 3 }]);
    const hits = store.queryByName('foo');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ filePath: 'a.ts', name: 'foo', line: 3 });
  });

  it('upsertFile replaces prior defs for that file (no duplicates)', () => {
    store.upsertFile('a.ts', [{ name: 'foo', kind: 'k', line: 1 }]);
    store.upsertFile('a.ts', [{ name: 'bar', kind: 'k', line: 2 }]);
    expect(store.queryByName('foo')).toHaveLength(0);
    expect(store.queryByName('bar')).toHaveLength(1);
  });

  it('queryByName can scope to a file', () => {
    store.upsertFile('a.ts', [{ name: 'dup', kind: 'k', line: 1 }]);
    store.upsertFile('b.ts', [{ name: 'dup', kind: 'k', line: 1 }]);
    expect(store.queryByName('dup')).toHaveLength(2);
    expect(store.queryByName('dup', 'b.ts')).toHaveLength(1);
  });

  it("deleteFile removes a file's defs", () => {
    store.upsertFile('a.ts', [{ name: 'foo', kind: 'k', line: 1 }]);
    store.deleteFile('a.ts');
    expect(store.queryByName('foo')).toHaveLength(0);
  });

  it('meta round-trips', () => {
    expect(store.getMeta('indexed_commit')).toBeUndefined();
    store.setMeta('indexed_commit', 'abc123');
    expect(store.getMeta('indexed_commit')).toBe('abc123');
  });

  it('isolates stores per repo root (distinct db files)', () => {
    store.upsertFile('a.ts', [{ name: 'foo', kind: 'k', line: 1 }]);
    const other = openSymbolStore('/other/repo');
    expect(other.queryByName('foo')).toHaveLength(0);
    other.close();
  });
});
