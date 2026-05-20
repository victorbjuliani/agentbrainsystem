import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../embedding/index.js';
import { LocalEmbeddingProvider } from '../embedding/index.js';
import { MemoryStore } from '../store/index.js';
import { Indexer } from './indexer.js';

/** Deterministic, offline provider so lifecycle branches test fast without a model. */
class FakeProvider implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-v1';
  readonly dimensions = 8;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vec(t));
  }
  private vec(t: string): number[] {
    const v = new Array(this.dimensions).fill(0) as number[];
    for (let i = 0; i < t.length; i++) {
      v[i % this.dimensions] = (v[i % this.dimensions] ?? 0) + t.charCodeAt(i);
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}

let dir: string;

function newStore(dims: number, name = 'memory.db'): MemoryStore {
  return new MemoryStore({ dbPath: join(dir, name), dimensions: dims }).open();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-indexer-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Indexer — index at write', () => {
  it('embeds and persists vector + FTS when writing an observation', async () => {
    const store = newStore(8);
    const indexer = new Indexer(store, new FakeProvider());
    const sessionId = store.createSession({ externalId: 's1' });

    const obsId = await indexer.write({ sessionId, kind: 'note', content: 'hello world cat' });

    const counts = store.counts();
    expect(counts.observations).toBe(1);
    expect(counts.vectors).toBe(1);
    expect(counts.fts).toBe(1);

    // the written observation is retrievable by its own vector
    const [vector] = await new FakeProvider().embed(['hello world cat']);
    const hits = store.knn(vector as number[], 1);
    expect(hits[0]?.id).toBe(obsId);

    const ftsHits = store.searchFts('cat', 5);
    expect(ftsHits.map((h) => h.id)).toContain(obsId);
    store.close();
  });
});

/** Provider that always fails — to test the write rollback path. */
class FailingProvider implements EmbeddingProvider {
  readonly id = 'failing';
  readonly model = 'fail-v1';
  readonly dimensions = 8;
  async embed(): Promise<number[][]> {
    throw new Error('embed boom');
  }
}

describe('Indexer — atomic write', () => {
  it('rolls back the observation row when embedding fails', async () => {
    const store = newStore(8);
    const indexer = new Indexer(store, new FailingProvider());
    const sessionId = store.createSession({ externalId: 's1' });

    await expect(indexer.write({ sessionId, kind: 'note', content: 'will fail' })).rejects.toThrow(
      'embed boom',
    );

    // no orphan: the row must not survive a failed embed
    const counts = store.counts();
    expect(counts).toMatchObject({ observations: 0, vectors: 0, fts: 0 });
    store.close();
  });
});

describe('Indexer — status reports reality', () => {
  it('reports real counts and not-stale after writes', async () => {
    const store = newStore(8);
    const indexer = new Indexer(store, new FakeProvider());
    const sessionId = store.createSession({ externalId: 's1' });
    await indexer.write({ sessionId, kind: 'note', content: 'alpha' });
    await indexer.write({ sessionId, kind: 'note', content: 'beta' });

    const status = indexer.status();
    expect(status).toMatchObject({ observations: 2, vectors: 2, fts: 2, stale: false });
    expect(status.signature).toBe('fake:fake-v1:8');
    store.close();
  });
});

describe('Indexer — deterministic rebuild gate', () => {
  it('rebuilds when observations exist but index is empty (never-built)', async () => {
    const store = newStore(8);
    const indexer = new Indexer(store, new FakeProvider());
    const sessionId = store.createSession({ externalId: 's1' });
    // write straight to the store, bypassing the indexer → unindexed rows
    store.createObservation({ sessionId, kind: 'note', content: 'unindexed one' });
    store.createObservation({ sessionId, kind: 'note', content: 'unindexed two' });
    expect(store.counts().vectors).toBe(0);

    const result = await indexer.ensureIndex();
    expect(result.rebuilt).toBe(true);
    expect(result.reason).toBe('never-built');
    expect(store.counts().vectors).toBe(2);
    expect(store.counts().fts).toBe(2);
    expect(indexer.status().stale).toBe(false);
    store.close();
  });

  it('rebuilds on count drift (some vectors missing)', async () => {
    const store = newStore(8);
    const indexer = new Indexer(store, new FakeProvider());
    const sessionId = store.createSession({ externalId: 's1' });
    await indexer.write({ sessionId, kind: 'note', content: 'a' });
    const id2 = store.createObservation({ sessionId, kind: 'note', content: 'b' }); // unindexed
    expect(store.counts()).toMatchObject({ observations: 2, vectors: 1 });

    const result = await indexer.ensureIndex();
    expect(result.rebuilt).toBe(true);
    expect(result.reason).toBe('count-drift');
    expect(store.knn((await new FakeProvider().embed(['b']))[0] as number[], 1)[0]?.id).toBe(id2);
    store.close();
  });

  it('rebuilds when the embedding signature changed', async () => {
    const store = newStore(8);
    const indexer = new Indexer(store, new FakeProvider());
    const sessionId = store.createSession({ externalId: 's1' });
    await indexer.write({ sessionId, kind: 'note', content: 'a' });
    // simulate a provider/model swap recorded under a stale signature
    store.setMeta('embed_signature', 'fake:OLD-MODEL:8');

    const result = await indexer.ensureIndex();
    expect(result.rebuilt).toBe(true);
    expect(result.reason).toBe('signature-change');
    expect(indexer.status().signature).toBe('fake:fake-v1:8');
    store.close();
  });

  it('is a no-op on a fresh index', async () => {
    const store = newStore(8);
    const indexer = new Indexer(store, new FakeProvider());
    const sessionId = store.createSession({ externalId: 's1' });
    await indexer.write({ sessionId, kind: 'note', content: 'a' });

    const result = await indexer.ensureIndex();
    expect(result.rebuilt).toBe(false);
    expect(result.reason).toBe('fresh');
    store.close();
  });
});

describe('Indexer — restart survival (integration, real local embeddings)', () => {
  it('write -> restart -> index intact, no rebuild needed', async () => {
    const provider = new LocalEmbeddingProvider();
    const dbName = 'restart.db';

    // session 1: open, write, close
    const store1 = newStore(provider.dimensions, dbName);
    const indexer1 = new Indexer(store1, provider);
    const sessionId = store1.createSession({ externalId: 's1' });
    const obsId = await indexer1.write({
      sessionId,
      kind: 'lesson',
      content: 'index must survive a process restart',
    });
    const countsBefore = store1.counts();
    store1.close();

    // session 2: reopen the SAME file, ensure index — should be fresh, intact
    const store2 = newStore(provider.dimensions, dbName);
    const indexer2 = new Indexer(store2, provider);
    const ensure = await indexer2.ensureIndex();

    expect(ensure.rebuilt).toBe(false);
    expect(ensure.reason).toBe('fresh');
    expect(store2.counts()).toEqual(countsBefore);

    // semantic recall still finds the observation after restart
    const [q] = await provider.embed(['surviving a restart']);
    const hits = store2.knn(q as number[], 1);
    expect(hits[0]?.id).toBe(obsId);
    store2.close();
  });
});
