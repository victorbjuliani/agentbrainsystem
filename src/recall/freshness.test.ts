import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../store/index.js';
import { annotateFreshness, freshnessTag } from './freshness.js';
import type { RecallHit } from './recall.js';

const DIM = 384;

describe('annotateFreshness (#27)', () => {
  let dir: string;
  let store: MemoryStore;
  let sessionId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-fresh-'));
    store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: DIM }).open();
    sessionId = store.createSession({ externalId: 's', project: 'p' });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function obsWithAnchor(state?: 'claimed' | 'verified' | 'stale'): RecallHit {
    const id = store.createObservation({
      sessionId,
      kind: 'tool_edit',
      content: `fact ${Math.random()}`,
    });
    if (state) {
      store.createAnchor({ observationId: id, anchorKind: 'file', filePath: 'f.ts', state });
    }
    const observation = store.getObservation(id);
    if (!observation) throw new Error('missing');
    return { observation, score: 1 };
  }

  it('labels each hit with its folded anchor state', () => {
    const hits = [obsWithAnchor('verified'), obsWithAnchor('claimed'), obsWithAnchor()];
    const out = annotateFreshness(store, hits);
    const states = out.map((h) => h.anchorState);
    expect(states).toContain('verified');
    expect(states).toContain('claimed');
    expect(states).toContain(undefined); // conversational fact
  });

  it('folds worst-wins: any stale anchor makes the fact stale', () => {
    const id = store.createObservation({ sessionId, kind: 'tool_edit', content: 'mixed' });
    store.createAnchor({
      observationId: id,
      anchorKind: 'symbol',
      qualifiedName: 'a',
      filePath: 'f.ts',
      state: 'verified',
    });
    store.createAnchor({
      observationId: id,
      anchorKind: 'symbol',
      qualifiedName: 'b',
      filePath: 'f.ts',
      state: 'stale',
    });
    const observation = store.getObservation(id);
    if (!observation) throw new Error('missing');
    const [out] = annotateFreshness(store, [{ observation, score: 1 }]);
    expect(out?.anchorState).toBe('stale');
  });

  it('demotes stale hits to the end, preserving order otherwise', () => {
    const verified = obsWithAnchor('verified');
    const stale = obsWithAnchor('stale');
    const claimed = obsWithAnchor('claimed');
    const out = annotateFreshness(store, [verified, stale, claimed]);
    // stale sinks last; the two non-stale keep their relative order.
    expect(out.at(-1)?.anchorState).toBe('stale');
    expect(out[0]?.observation.id).toBe(verified.observation.id);
    expect(out[1]?.observation.id).toBe(claimed.observation.id);
  });

  it('freshnessTag renders compact labels', () => {
    expect(freshnessTag('verified')).toBe(' ✓verified');
    expect(freshnessTag('claimed')).toBe(' ~claimed');
    expect(freshnessTag('stale')).toBe(' ⚠stale');
    expect(freshnessTag(undefined)).toBe('');
  });
});
