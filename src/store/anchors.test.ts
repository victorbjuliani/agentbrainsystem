import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store.js';

const DIM = 384;

/**
 * fact_anchors CRUD + reverse lookups (issue #23) — the storage substrate of
 * the verifiable-memory (E) layer. Covers the reverse indexes self-healing
 * depends on and the claimed→verified→stale state machine.
 */
describe('MemoryStore fact anchors', () => {
  let dir: string;
  let store: MemoryStore;
  let obsId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-anchors-'));
    store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: DIM });
    store.open();
    const sessionId = store.createSession({ externalId: 'sess', project: 'p' });
    obsId = store.createObservation({ sessionId, kind: 'tool', content: 'edited foo' });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates an anchor defaulting to claimed and round-trips it', () => {
    const id = store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'mod.foo',
      filePath: 'src/mod.ts',
      line: 42,
    });
    const anchor = store.getAnchorsForObservation(obsId)[0];
    expect(anchor?.id).toBe(id);
    expect(anchor?.state).toBe('claimed');
    expect(anchor?.qualifiedName).toBe('mod.foo');
    expect(anchor?.filePath).toBe('src/mod.ts');
    expect(anchor?.line).toBe(42);
    expect(anchor?.commitSha).toBeUndefined();
  });

  it('reverse-looks-up anchors by symbol (the self-healing access pattern)', () => {
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'mod.foo',
      filePath: 'src/mod.ts',
    });
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'mod.bar',
      filePath: 'src/mod.ts',
    });
    expect(store.findAnchorsBySymbol('mod.foo')).toHaveLength(1);
    expect(store.findAnchorsBySymbol('mod.foo')[0]?.qualifiedName).toBe('mod.foo');
    expect(store.findAnchorsBySymbol('missing')).toHaveLength(0);
  });

  it('reverse-looks-up anchors by file path', () => {
    store.createAnchor({ observationId: obsId, anchorKind: 'file', filePath: 'src/a.ts' });
    store.createAnchor({ observationId: obsId, anchorKind: 'file', filePath: 'src/b.ts' });
    expect(store.findAnchorsByFile('src/a.ts')).toHaveLength(1);
    expect(store.findAnchorsByFile('src/a.ts')[0]?.anchorKind).toBe('file');
  });

  it('promotes claimed → verified, pinning commit/line and stamping verifiedAt', () => {
    const id = store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'mod.foo',
      filePath: 'src/mod.ts',
    });
    store.updateAnchorState(id, 'verified', { commitSha: 'abc123', line: 7 });
    const anchor = store.getAnchorsForObservation(obsId)[0];
    expect(anchor?.state).toBe('verified');
    expect(anchor?.commitSha).toBe('abc123');
    expect(anchor?.line).toBe(7);
    expect(anchor?.verifiedAt).toBeTruthy();
  });

  it('marks stale without deleting the row (invalidation is auditable)', () => {
    const id = store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'mod.foo',
      filePath: 'src/mod.ts',
      state: 'verified',
    });
    store.updateAnchorState(id, 'stale');
    const anchor = store.getAnchorsForObservation(obsId)[0];
    expect(anchor?.state).toBe('stale');
    expect(store.getAnchorsForObservation(obsId)).toHaveLength(1);
  });

  it('lists anchors by state and counts per state', () => {
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'a',
      filePath: 'f.ts',
      state: 'claimed',
    });
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'b',
      filePath: 'f.ts',
      state: 'verified',
    });
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'c',
      filePath: 'f.ts',
      state: 'verified',
    });
    expect(store.listAnchorsByState('verified')).toHaveLength(2);
    expect(store.listAnchorsByState('claimed', 1)).toHaveLength(1);
    expect(store.countAnchorsByState()).toEqual({ claimed: 1, verified: 2, stale: 0 });
  });

  it('cascades anchor deletion when the observation is deleted', () => {
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'mod.foo',
      filePath: 'src/mod.ts',
    });
    store.deleteObservation(obsId);
    expect(store.getAnchorsForObservation(obsId)).toHaveLength(0);
  });
});
