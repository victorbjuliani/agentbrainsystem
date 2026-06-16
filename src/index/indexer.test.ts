import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireIndexLock, refreshIndex } from './indexer.js';
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

  it('is a no-op on a non-git dir (never throws, not ready)', async () => {
    const nogit = mkdtempSync(join(tmpdir(), 'abs-nogit-'));
    await expect(refreshIndex(nogit)).resolves.toEqual({ ready: false });
    rmSync(nogit, { recursive: true, force: true });
  });

  // #106 — interactive time-box, single-flight per repo, atomic commit stamp.
  it('reports ready=true once the committed index reflects HEAD', async () => {
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}');
    commit('init');
    const r = await refreshIndex(repo);
    expect(r.ready).toBe(true);
    const store = openSymbolStore(repo);
    expect(store.getMeta('indexed_commit')).toBeTruthy(); // stamped
    store.close();
  });

  it('budget=0 truncates the cold build: nothing stamped, not ready, idempotent recovery', async () => {
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}');
    writeFileSync(join(repo, 'b.ts'), 'export function bar(){}');
    commit('init');
    // A zero budget trips before the first parse → no ops applied, commit NOT stamped.
    const truncated = await refreshIndex(repo, { budgetMs: 0 });
    expect(truncated.ready).toBe(false);
    const s1 = openSymbolStore(repo);
    expect(s1.getMeta('indexed_commit')).toBeUndefined(); // never stamped ahead of state
    s1.close();
    // An unbudgeted refresh finishes the build and stamps.
    const full = await refreshIndex(repo);
    expect(full.ready).toBe(true);
    const s2 = openSymbolStore(repo);
    expect(s2.queryByName('foo')).toHaveLength(1);
    expect(s2.getMeta('indexed_commit')).toBeTruthy();
    s2.close();
  });

  it('budgeted path skips an oversized file (deferred, not stamped); unbudgeted indexes it', async () => {
    // A >256KB file whose tree-sitter parse could blow the interactive budget mid-await.
    const filler = `// pad\n${'x'.repeat(300 * 1024)}\n`;
    writeFileSync(join(repo, 'big.ts'), `export function huge(){}\n${filler}`);
    commit('init');
    // Budgeted (but generous time): the size guard, not the clock, defers the big file.
    const budgeted = await refreshIndex(repo, { budgetMs: 60_000 });
    expect(budgeted.ready).toBe(false); // deferred file → build incomplete → not ready
    const s1 = openSymbolStore(repo);
    expect(s1.queryByName('huge')).toHaveLength(0); // skipped on the interactive path
    expect(s1.getMeta('indexed_commit')).toBeUndefined(); // not stamped ahead of state
    s1.close();
    // Unbudgeted refresh has no size guard → indexes the big file and stamps.
    const full = await refreshIndex(repo);
    expect(full.ready).toBe(true);
    const s2 = openSymbolStore(repo);
    expect(s2.queryByName('huge')).toHaveLength(1);
    s2.close();
  });

  it('single-flight: a refresh skips (reuses the index) while another holds the repo lock', async () => {
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}');
    commit('init');
    await refreshIndex(repo); // warm the index → at HEAD
    // Simulate a concurrent holder by taking the lock file ourselves.
    const store = openSymbolStore(repo);
    const lockPath = `${store.dbPath}.refresh.lock`;
    store.close();
    writeFileSync(lockPath, `${process.pid} ${Date.now()}`);
    // A new uncommitted file: if the refresh ran the overlay it would index `bar`.
    writeFileSync(join(repo, 'b.ts'), 'export function bar(){}');
    try {
      // The lock is held + fresh → this refresh must SKIP the build (no overlay), but the
      // committed index is already at HEAD so it still reports ready (reuse).
      const r = await refreshIndex(repo);
      expect(r.ready).toBe(true);
      const s = openSymbolStore(repo);
      expect(s.queryByName('bar')).toHaveLength(0); // skipped → overlay never ran
      s.close();
    } finally {
      rmSync(lockPath, { force: true });
    }
  });

  it('reconciles a dirty→clean revert — no stale overlay symbols (F7-06)', async () => {
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}');
    commit('c1');
    await refreshIndex(repo);

    // A dirty (uncommitted) edit adds `bar` via the working-tree overlay.
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}\nexport function bar(){}');
    await refreshIndex(repo);
    let store = openSymbolStore(repo);
    expect(store.queryByName('bar')).toHaveLength(1);
    store.close();

    // Revert the edit (NO commit): tree clean, HEAD unchanged so the commit path is a
    // no-op. The overlay's `bar` must be reconciled away, not left as residue.
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}');
    await refreshIndex(repo);
    store = openSymbolStore(repo);
    expect(store.queryByName('bar')).toHaveLength(0); // overlay residue cleared
    expect(store.queryByName('foo')).toHaveLength(1); // committed symbol intact
    store.close();
  });

  it('reconciles a dirty untracked file that is then deleted (F7-06)', async () => {
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}');
    commit('c1');
    await refreshIndex(repo);

    // An untracked file enters the overlay…
    writeFileSync(join(repo, 'scratch.ts'), 'export function scratch(){}');
    await refreshIndex(repo);
    let store = openSymbolStore(repo);
    expect(store.queryByName('scratch')).toHaveLength(1);
    store.close();

    // …then is deleted. It is no longer dirty, so reconciliation must drop its symbols.
    rmSync(join(repo, 'scratch.ts'));
    await refreshIndex(repo);
    store = openSymbolStore(repo);
    expect(store.queryByName('scratch')).toHaveLength(0);
    store.close();
  });

  it('cold-rebuilds when the stored indexed_commit no longer exists (F7-05 follow-up)', async () => {
    // Codex review on PR #170: a pruned/rebased/re-cloned base makes `git diff <old> HEAD`
    // fail permanently (status 128). The refresh must recover via a cold re-list, not stay
    // not-ready forever retrying the impossible diff.
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}');
    commit('c1');
    await refreshIndex(repo); // stamps the real HEAD

    let store = openSymbolStore(repo);
    store.setMeta('indexed_commit', '0000000000000000000000000000000000000000'); // bogus base
    store.close();
    writeFileSync(join(repo, 'b.ts'), 'export function bar(){}');
    commit('c2');

    const r = await refreshIndex(repo);
    expect(r.ready).toBe(true); // recovered, not stuck not-ready
    store = openSymbolStore(repo);
    expect(store.getMeta('indexed_commit')).toBeTruthy();
    expect(store.queryByName('foo')).toHaveLength(1); // full re-list indexed everything
    expect(store.queryByName('bar')).toHaveLength(1);
    store.close();
  });
});

describe('acquireIndexLock — atomic ownership & steal (F1-03)', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-ixlock-'));
    dbPath = join(dir, 'repo.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lockPath = () => `${dbPath}.refresh.lock`;
  const foreign = (token: string) =>
    writeFileSync(lockPath(), JSON.stringify({ pid: 99999, token, startedAt: '' }));

  it('acquires on a free path; release removes the lockfile', () => {
    const lock = acquireIndexLock(dbPath);
    expect(lock).not.toBeNull();
    expect(existsSync(lockPath())).toBe(true);
    lock?.release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('uses a filesystem-safe token — no colon in the steal scratch name (Windows, PR #168)', () => {
    const lock = acquireIndexLock(dbPath);
    expect(lock).not.toBeNull();
    const { token } = JSON.parse(readFileSync(lockPath(), 'utf8')) as { token: string };
    // The token is embedded in `.dead-${token}`; `:` is invalid on Windows. pid-uuid only.
    expect(token).not.toContain(':');
    expect(token).toMatch(/^\d+-[0-9a-f-]+$/i);
    lock?.release();
  });

  it('returns null when a fresh foreign lock is held (no steal of a live holder)', () => {
    foreign('peer');
    expect(acquireIndexLock(dbPath)).toBeNull();
    expect(existsSync(lockPath())).toBe(true); // peer's lock untouched
  });

  it('release does NOT delete a peer lock that stole our slot after a stall (token-checked)', () => {
    const lock = acquireIndexLock(dbPath);
    expect(lock).not.toBeNull();
    // A peer takes the slot with a DIFFERENT token (as if it stole a stale lock).
    foreign('peer');
    lock?.release(); // must no-op — we no longer own the file
    expect(existsSync(lockPath())).toBe(true); // the peer's lock survives
  });

  it('atomically steals a STALE lock (dead holder past the TTL), no .dead residue', () => {
    foreign('dead');
    const old = (Date.now() - 60_000) / 1000; // well past LOCK_TTL_MS (30s)
    utimesSync(lockPath(), old, old);
    const lock = acquireIndexLock(dbPath);
    expect(lock).not.toBeNull(); // stale → stolen
    lock?.release(); // the stolen lock is now ours → release removes it
    expect(existsSync(lockPath())).toBe(false);
    expect(readdirSync(dir).some((f) => f.includes('.dead-'))).toBe(false);
  });
});
