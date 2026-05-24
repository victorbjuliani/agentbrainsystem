import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refreshIndex } from './indexer.js';
import { openSymbolStore } from './symbol-store.js';

function git(root: string, ...a: string[]) {
  execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
}

describe('refreshIndex', () => {
  let home: string;
  let repo: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'abs-ixhome-'));
    process.env.ABS_HOME = home;
    process.env.ABS_WASM_DIR = join(__dirname, '../../dist/index/wasm');
    repo = mkdtempSync(join(tmpdir(), 'abs-ixrepo-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
  });
  afterEach(() => {
    delete process.env.ABS_HOME;
    delete process.env.ABS_WASM_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
  const commit = (m: string) => {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', m);
  };

  it('full build indexes committed supported files', async () => {
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}');
    commit('init');
    await refreshIndex(repo);
    const store = openSymbolStore(repo);
    expect(store.queryByName('foo').map((h) => h.filePath)).toEqual(['a.ts']);
    store.close();
  });

  it('incremental: a symbol moved to another file is re-located', async () => {
    writeFileSync(join(repo, 'a.ts'), 'export function moved(){}');
    commit('c1');
    await refreshIndex(repo);
    writeFileSync(join(repo, 'a.ts'), '// gone');
    writeFileSync(join(repo, 'b.ts'), 'export function moved(){}');
    commit('c2');
    await refreshIndex(repo);
    const store = openSymbolStore(repo);
    expect(store.queryByName('moved').map((h) => h.filePath)).toEqual(['b.ts']);
    store.close();
  });

  it('dirty overlay reflects an uncommitted edit', async () => {
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}');
    commit('c1');
    await refreshIndex(repo);
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}\nexport function added(){}');
    await refreshIndex(repo);
    const store = openSymbolStore(repo);
    expect(store.queryByName('added')).toHaveLength(1);
    store.close();
  });

  it('drops a removed symbol on the next refresh (enables stale)', async () => {
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}');
    commit('c1');
    await refreshIndex(repo);
    writeFileSync(join(repo, 'a.ts'), '// removed');
    commit('c2');
    await refreshIndex(repo);
    const store = openSymbolStore(repo);
    expect(store.queryByName('foo')).toHaveLength(0);
    store.close();
  });

  it('is a no-op on a non-git dir (never throws)', async () => {
    const nogit = mkdtempSync(join(tmpdir(), 'abs-nogit-'));
    await expect(refreshIndex(nogit)).resolves.toBeUndefined();
    rmSync(nogit, { recursive: true, force: true });
  });
});
