import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// F7-05: a transient `git diff` failure returns `undefined` (NOT an empty diff), and the
// indexer must NOT stamp `indexed_commit` over content it never indexed. Force exactly
// that by mocking ONLY `diffNames` to fail, keeping the rest of the git helpers real so
// the cold build (via lsFiles) and HEAD reads work normally. Isolated in its own file so
// the mock can't leak into the main indexer suite (which relies on a real `diffNames`).
vi.mock('./git.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./git.js')>();
  return { ...real, diffNames: () => undefined };
});

import { refreshIndex } from './indexer.js';
import { openSymbolStore } from './symbol-store.js';

function git(root: string, ...a: string[]) {
  execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
}

describe('refreshIndex — git failure must not false-fresh the index (F7-05)', () => {
  let home: string;
  let repo: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'abs-gitfail-home-'));
    process.env.ABS_HOME = home;
    process.env.ABS_WASM_DIR = join(__dirname, '../../dist/index/wasm');
    repo = mkdtempSync(join(tmpdir(), 'abs-gitfail-repo-'));
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

  it('does NOT advance indexed_commit when the diff fails (no false-fresh stamp)', async () => {
    // Cold build uses lsFiles (real) → stamps the first commit normally.
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}');
    commit('c1');
    await refreshIndex(repo);
    let store = openSymbolStore(repo);
    const stampedAt = store.getMeta('indexed_commit');
    expect(stampedAt).toBeTruthy();
    store.close();

    // A second commit means the incremental path runs `diffNames` — which the mock makes
    // fail. The stamp must STAY at c1 (not advance to c2 over un-indexed content), and the
    // refresh must report not-ready so an interactive caller skips the stale index.
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}\nexport function bar(){}');
    commit('c2');
    const r = await refreshIndex(repo);
    expect(r.ready).toBe(false);
    store = openSymbolStore(repo);
    expect(store.getMeta('indexed_commit')).toBe(stampedAt); // unchanged — no false-fresh
    expect(store.queryByName('bar')).toHaveLength(0); // c2 content was never indexed
    store.close();
  });
});
