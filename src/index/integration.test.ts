import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepAnchors, verifyOnRecall } from '../anchoring/index.js';
import { createGroundTruthProvider } from '../ground-truth/index.js';
import { openMemory } from '../memory.js';
import { refreshIndex } from './indexer.js';

function git(root: string, ...a: string[]) {
  execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
}

describe('native ground-truth end-to-end (no external graph)', () => {
  let home: string;
  let repo: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'abs-e2eH-'));
    process.env.ABS_HOME = home;
    process.env.ABS_WASM_DIR = join(__dirname, '../../dist/index/wasm');
    repo = mkdtempSync(join(tmpdir(), 'abs-e2eR-'));
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

  it('claimed→verified→(move)verified→(remove)stale via the native index', async () => {
    writeFileSync(join(repo, 'sync.ts'), 'export function mergeNotes(){ return 1; }');
    commit('c1');

    const m = await openMemory(undefined, { ensure: false });
    const sid = m.store.createSession({ externalId: 's', project: 'p' });
    const obs = m.store.createObservation({
      sessionId: sid,
      kind: 'decision',
      content: 'mergeNotes order-stable',
    });
    m.store.createAnchor({
      observationId: obs,
      anchorKind: 'symbol',
      qualifiedName: 'mergeNotes',
      filePath: join(repo, 'sync.ts'),
    });

    await refreshIndex(repo);
    let provider = createGroundTruthProvider(repo);
    sweepAnchors(m.store, provider, {});
    provider.close();
    expect(m.store.getAnchorsForObservation(obs).some((a) => a.state === 'verified')).toBe(true);

    // move the symbol to another file → stays verified (re-anchored)
    writeFileSync(join(repo, 'sync.ts'), '// moved out');
    writeFileSync(join(repo, 'merge.ts'), 'export function mergeNotes(){ return 1; }');
    commit('c2');
    await refreshIndex(repo);
    provider = createGroundTruthProvider(repo);
    verifyOnRecall(m.store, provider, [obs]);
    provider.close();
    expect(m.store.getAnchorsForObservation(obs).every((a) => a.state !== 'stale')).toBe(true);

    // remove the symbol → stale
    writeFileSync(join(repo, 'merge.ts'), '// gone');
    commit('c3');
    await refreshIndex(repo);
    provider = createGroundTruthProvider(repo);
    verifyOnRecall(m.store, provider, [obs]);
    provider.close();
    expect(m.store.getAnchorsForObservation(obs).some((a) => a.state === 'stale')).toBe(true);

    m.close();
  });
});
