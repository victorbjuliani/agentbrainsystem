import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../store/index.js';
import { annotateFreshness } from './freshness.js';
import type { RecallHit } from './recall.js';

const DIM = 384;

/** Branch scoping (FR-C1, #31): anchors record a branch; recall flags cross-branch facts. */
describe('branch scoping (#31)', () => {
  let dir: string;
  let store: MemoryStore;
  let sessionId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-branch-'));
    store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: DIM }).open();
    sessionId = store.createSession({ externalId: 's', project: 'p' });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function hitFor(obsId: number): RecallHit {
    const observation = store.getObservation(obsId);
    if (!observation) throw new Error('missing');
    return { observation, score: 1 };
  }

  it('round-trips branch on an anchor', () => {
    const obsId = store.createObservation({ sessionId, kind: 'tool_edit', content: 'edit' });
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'file',
      filePath: 'f.ts',
      state: 'verified',
      branch: 'feat/x',
    });
    expect(store.findAnchorsByFile('f.ts')[0]?.branch).toBe('feat/x');
  });

  it('flags a fact verified on another branch as crossBranch', () => {
    const obsId = store.createObservation({ sessionId, kind: 'tool_edit', content: 'edit' });
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'file',
      filePath: 'f.ts',
      state: 'verified',
      branch: 'feat/x',
    });
    const [hit] = annotateFreshness(store, [hitFor(obsId)], 'main');
    expect(hit?.crossBranch).toBe(true);
  });

  it('does not flag a fact verified on the current branch', () => {
    const obsId = store.createObservation({ sessionId, kind: 'tool_edit', content: 'edit' });
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'file',
      filePath: 'f.ts',
      state: 'verified',
      branch: 'main',
    });
    const [hit] = annotateFreshness(store, [hitFor(obsId)], 'main');
    expect(hit?.crossBranch).toBeUndefined();
  });

  it('never flags when no current branch is supplied (offline-safe)', () => {
    const obsId = store.createObservation({ sessionId, kind: 'tool_edit', content: 'edit' });
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'file',
      filePath: 'f.ts',
      state: 'verified',
      branch: 'feat/x',
    });
    const [hit] = annotateFreshness(store, [hitFor(obsId)]);
    expect(hit?.crossBranch).toBeUndefined();
  });
});
