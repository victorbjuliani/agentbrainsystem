import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import { type Memory, openMemory } from '../memory.js';
import { MemoryStore } from '../store/index.js';
import { Recall } from './recall.js';

let dir: string;

function config(): AppConfig {
  return {
    dataDir: dir,
    dbPath: join(dir, 'memory.db'),
    embedding: { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384 },
    recallScope: 'global',
  };
}

const CORPUS: Array<{ kind: string; content: string }> = [
  { kind: 'note', content: 'The capital of France is Paris and it sits on the Seine.' },
  {
    kind: 'note',
    content: 'Python list comprehensions build lists from an iterable in one expression.',
  },
  { kind: 'note', content: 'Docker Compose sets up networking between multiple containers.' },
  { kind: 'lesson', content: 'Use git rebase --interactive to squash several commits into one.' },
  { kind: 'note', content: 'SQLite WAL mode keeps writes durable across process restarts.' },
];

async function seed(mem: Memory): Promise<void> {
  const sessionId = mem.store.createSession({ externalId: 's1' });
  for (const obs of CORPUS) {
    await mem.indexer.write({ sessionId, kind: obs.kind, content: obs.content });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-recall-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Recall — semantic acceptance', () => {
  it('returns a saved item in the top-3 for a semantic query', async () => {
    const mem = await openMemory(config());
    await seed(mem);

    const hits = await mem.recall.recall('how do I squash commits in version control', {
      limit: 3,
    });
    const contents = hits.map((h) => h.observation.content);
    expect(contents.some((c) => c.includes('git rebase'))).toBe(true);
    mem.close();
  });

  it('hybrid recall with a project filters BOTH legs — no cross-project leak (#47)', async () => {
    const mem = await openMemory(config());
    const a = mem.store.createSession({ externalId: 'a', project: 'ProjA' });
    const b = mem.store.createSession({ externalId: 'b', project: 'ProjB' });
    await mem.indexer.write({
      sessionId: a,
      kind: 'note',
      content: 'ProjA: the refund window is 30 days.',
    });
    await mem.indexer.write({
      sessionId: b,
      kind: 'note',
      content: 'ProjB: kubernetes ingress uses nginx with TLS.',
    });

    // A query that matches ProjB content, scoped to ProjA → must not surface ProjB.
    const scopedA = await mem.recall.recall('kubernetes ingress nginx tls', {
      limit: 5,
      project: 'ProjA',
    });
    expect(scopedA.some((h) => h.observation.content.includes('kubernetes'))).toBe(false);

    // Same query scoped to ProjB → surfaces it.
    const scopedB = await mem.recall.recall('kubernetes ingress nginx tls', {
      limit: 5,
      project: 'ProjB',
    });
    expect(scopedB.some((h) => h.observation.content.includes('kubernetes'))).toBe(true);
    mem.close();
  });

  it('hybrid recall with includeGlobal surfaces global-brain hits alongside the project (#)', async () => {
    const mem = await openMemory(config());
    const a = mem.store.createSession({ externalId: 'a', project: 'ProjA' });
    const g = mem.store.createSession({ externalId: '__global__', project: '__global__' });
    await mem.indexer.write({ sessionId: a, kind: 'note', content: 'ProjA: deploy on fridays' });
    await mem.indexer.write({
      sessionId: g,
      kind: 'decision',
      content: 'Global rule: always write tests first',
    });

    // Scoped to ProjA WITHOUT includeGlobal → the global decision must not surface.
    const scoped = await mem.recall.recall('always write tests first', {
      limit: 5,
      project: 'ProjA',
    });
    expect(scoped.some((h) => h.observation.content.includes('always write tests'))).toBe(false);

    // Scoped to ProjA WITH includeGlobal → the global decision surfaces.
    const withGlobal = await mem.recall.recall('always write tests first', {
      limit: 5,
      project: 'ProjA',
      includeGlobal: true,
    });
    expect(withGlobal.some((h) => h.observation.content.includes('always write tests'))).toBe(true);
    mem.close();
  });

  it('matches on keyword overlap even when phrasing differs', async () => {
    const mem = await openMemory(config());
    await seed(mem);
    const hits = await mem.recall.recall('Paris France capital', { limit: 3 });
    expect(hits[0]?.observation.content).toContain('Paris');
    mem.close();
  });
});

/** Provider that explodes if embed() is ever called — proves the FTS path is embed-free. */
class ExplodingProvider implements EmbeddingProvider {
  readonly id = 'exploding';
  readonly model = 'none';
  readonly dimensions = 8;
  async embed(): Promise<number[][]> {
    throw new Error('recallFts must not embed (ADR-0005 FTS-first)');
  }
}

describe('Recall.recallFts — FTS-only fast path (#19 / ADR-0005)', () => {
  it('recalls by keyword WITHOUT calling provider.embed', () => {
    const store = new MemoryStore({ dbPath: join(dir, 'fts.db'), dimensions: 8 }).open();
    const sessionId = store.createSession({ externalId: 's1' });
    // Seed FTS directly — no embedding involved.
    for (const obs of CORPUS) {
      const id = store.createObservation({ sessionId, kind: obs.kind, content: obs.content });
      store.indexFts(id, obs.content);
    }
    const recall = new Recall(store, new ExplodingProvider());

    const hits = recall.recallFts('squash commits with git rebase', { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.observation.content.includes('git rebase'))).toBe(true);
    // FTS-only hits carry an ftsRank and no vectorRank.
    expect(hits[0]?.ftsRank).toBeDefined();
    expect(hits[0]?.vectorRank).toBeUndefined();
    store.close();
  });

  it('returns [] for a query with no searchable tokens', () => {
    const store = new MemoryStore({ dbPath: join(dir, 'fts2.db'), dimensions: 8 }).open();
    const recall = new Recall(store, new ExplodingProvider());
    expect(recall.recallFts('!!! @@@ ###', { limit: 5 })).toEqual([]);
    store.close();
  });

  it('marks global-session hits with global=true when includeGlobal is set', () => {
    const store = new MemoryStore({ dbPath: join(dir, 'fts-global.db'), dimensions: 8 }).open();
    const recall = new Recall(store, new ExplodingProvider());
    const proj = store.createSession({ externalId: 'p', project: '-Users-me-Devs-foo' });
    const glob = store.createSession({ externalId: '__global__', project: '__global__' });
    const op = store.createObservation({
      sessionId: proj,
      kind: 'note',
      content: 'zebra project note',
    });
    const og = store.createObservation({
      sessionId: glob,
      kind: 'decision',
      content: 'zebra global decision',
    });
    store.indexFts(op, 'zebra project note');
    store.indexFts(og, 'zebra global decision');

    const hits = recall.recallFts('zebra', {
      limit: 10,
      project: '-Users-me-Devs-foo',
      includeGlobal: true,
    });
    const byId = new Map(hits.map((h) => [h.observation.id, h]));
    expect(byId.get(op)?.global).toBeFalsy();
    expect(byId.get(og)?.global).toBe(true);
    store.close();
  });
});

describe('Recall — restart survival acceptance', () => {
  it('returns identical recall before and after a daemon restart', async () => {
    const cfg = config();

    // session 1: seed + recall
    const mem1 = await openMemory(cfg);
    await seed(mem1);
    const before = await mem1.recall.recall('durable storage that survives restart', { limit: 5 });
    mem1.close();

    // session 2: reopen the SAME db, recall the SAME query
    const mem2 = await openMemory(cfg);
    expect(mem2.ensure?.rebuilt).toBe(false); // index persisted, no rebuild needed
    const after = await mem2.recall.recall('durable storage that survives restart', { limit: 5 });
    mem2.close();

    expect(after.map((h) => h.observation.id)).toEqual(before.map((h) => h.observation.id));
    expect(after.map((h) => Number(h.score.toFixed(6)))).toEqual(
      before.map((h) => Number(h.score.toFixed(6))),
    );
  });
});
