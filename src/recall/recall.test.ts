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
    autoDistill: true,
    distillMinObs: 25,
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

describe('recallFts — kind-weighted re-rank (#141)', () => {
  let bdir: string;
  let store: MemoryStore;
  let recall: Recall;
  let sessionId: number;

  // recallFts never embeds; a stub provider that throws proves the FTS-only contract.
  const noEmbed: EmbeddingProvider = {
    id: 'noembed',
    model: 'none',
    dimensions: 8,
    embed: async () => {
      throw new Error('recallFts must not embed');
    },
  };

  // 40 unrelated words: padding a durable doc with these makes its bm25 score weak (one
  // matching term in a long doc) without matching the query — so FTS ranks it LAST while
  // the kind weight still has to lift it to the top.
  const FILLER = Array.from({ length: 40 }, (_, i) => `filler${i}`).join(' ');

  beforeEach(() => {
    bdir = mkdtempSync(join(tmpdir(), 'abs-recallfts-'));
    store = new MemoryStore({ dbPath: join(bdir, 'm.db'), dimensions: 8 }).open();
    recall = new Recall(store, noEmbed);
    sessionId = store.createSession({ externalId: 's1' });
  });

  afterEach(() => {
    store.close();
    rmSync(bdir, { recursive: true, force: true });
  });

  function add(kind: string, content: string): number {
    const id = store.createObservation({ sessionId, kind, content });
    store.indexFts(id, content);
    return id;
  }

  it('promotes a durable lesson above a stronger-FTS raw turn', () => {
    const raw = add('user', 'alpha alpha alpha');
    const durable = add('lesson', `alpha ${FILLER}`);

    // Baseline: pure FTS puts the strong raw match first.
    const fts = recall.recallFts('alpha', { limit: 5 });
    expect(fts[0]?.observation.id).toBe(raw);

    // rankByKind: the durable lesson is lifted to the top, raw still present (not a filter).
    const ranked = recall.recallFts('alpha', { limit: 5, rankByKind: true });
    expect(ranked[0]?.observation.id).toBe(durable);
    expect(ranked.map((h) => h.observation.id)).toContain(raw);
  });

  it('no durable match → order is pure FTS (flag is a no-op on all-raw results)', () => {
    // ≥3 raw docs with varying term frequency → a non-trivial FTS permutation, so the
    // assertion would catch a bug where raw kinds wrongly received a non-1 weight.
    add('user', 'beta beta beta');
    add('assistant', 'beta beta');
    add('user', 'beta gamma delta epsilon');

    const off = recall.recallFts('beta', { limit: 5 }).map((h) => h.observation.id);
    const explicitFalse = recall
      .recallFts('beta', { limit: 5, rankByKind: false })
      .map((h) => h.observation.id);
    const on = recall
      .recallFts('beta', { limit: 5, rankByKind: true })
      .map((h) => h.observation.id);
    expect(explicitFalse).toEqual(off); // explicit false == omitted
    expect(on).toEqual(off); // all weights equal → no reordering
  });

  it('default path does NOT promote durable kinds even when present (rankByKind off)', () => {
    const raw = add('user', 'phi phi phi');
    add('lesson', `phi ${FILLER}`); // durable but weak FTS

    // Without rankByKind, the durable lesson must NOT be lifted — pure FTS order stands.
    expect(recall.recallFts('phi', { limit: 5 })[0]?.observation.id).toBe(raw);
    expect(recall.recallFts('phi', { limit: 5, rankByKind: false })[0]?.observation.id).toBe(raw);
  });

  it('default path keeps the score = -distance contract; ranked path uses weighted score', () => {
    add('user', 'zeta');
    const [plain] = recall.recallFts('zeta', { limit: 1 });
    expect(plain?.score).toBe(-(plain?.ftsRank ?? 0));

    add('lesson', `zeta ${FILLER}`);
    const [weighted] = recall.recallFts('zeta', { limit: 1, rankByKind: true });
    // durable promoted; its score is the weighted value, not -distance
    expect(weighted?.score).not.toBe(-(weighted?.ftsRank ?? 0));
    expect(weighted?.score).toBeGreaterThan(0);
  });

  it('boundary (W1): a durable hit at the WORST candidate position still outranks the best raw', () => {
    add('user', 'kappa kappa kappa kappa');
    add('user', 'kappa kappa kappa');
    add('user', 'kappa kappa');
    const durable = add('lesson', `kappa ${FILLER}`); // weakest bm25 → last FTS position

    const ranked = recall.recallFts('kappa', { limit: 4, rankByKind: true });
    expect(ranked[0]?.observation.id).toBe(durable);
  });

  it('weak-match guard (W2): a weak durable hit does not evict the strongest raw match', () => {
    const strongRaw = add('user', 'omega omega omega omega omega');
    add('user', 'omega omega omega');
    add('user', 'omega omega');
    const durable = add('lesson', `omega ${FILLER}`);

    const ids = recall
      .recallFts('omega', { limit: 3, rankByKind: true })
      .map((h) => h.observation.id);
    expect(ids[0]).toBe(durable); // durable promoted
    expect(ids).toContain(strongRaw); // but the strongest raw is still in the top-3 set
  });

  it('candidate pool: a durable hit outside the limit window is surfaced via over-fetch', () => {
    const raw = add('user', 'sigma sigma sigma');
    const durable = add('lesson', `sigma ${FILLER}`);

    // limit:1 + pure FTS → only the strong raw match (durable is outside the window).
    expect(recall.recallFts('sigma', { limit: 1 }).map((h) => h.observation.id)).toEqual([raw]);
    // limit:1 + rankByKind → over-fetch reaches the durable hit and the weight surfaces it.
    expect(
      recall.recallFts('sigma', { limit: 1, rankByKind: true }).map((h) => h.observation.id),
    ).toEqual([durable]);
  });

  it('is deterministic across repeated calls (stable re-rank)', () => {
    add('lesson', 'tau one');
    add('user', 'tau two');
    add('note', 'tau three');

    const a = recall.recallFts('tau', { limit: 3, rankByKind: true }).map((h) => h.observation.id);
    const b = recall.recallFts('tau', { limit: 3, rankByKind: true }).map((h) => h.observation.id);
    expect(a).toEqual(b);
  });

  it('includeGlobal + rankByKind: a global durable hit is boosted AND tagged global (#141)', () => {
    // The exact signature both production hooks use: project-scoped + includeGlobal + rankByKind.
    const proj = store.createSession({ externalId: 'p', project: '-Users-me-Devs-foo' });
    const glob = store.createSession({ externalId: '__global__', project: '__global__' });
    const raw = store.createObservation({
      sessionId: proj,
      kind: 'user',
      content: 'upsilon upsilon upsilon', // strong in-project raw match
    });
    const gdur = store.createObservation({
      sessionId: glob,
      kind: 'decision',
      content: `upsilon ${FILLER}`, // weak global durable
    });
    store.indexFts(raw, 'upsilon upsilon upsilon');
    store.indexFts(gdur, `upsilon ${FILLER}`);

    const ranked = recall.recallFts('upsilon', {
      limit: 5,
      project: '-Users-me-Devs-foo',
      includeGlobal: true,
      rankByKind: true,
    });
    expect(ranked[0]?.observation.id).toBe(gdur); // global durable boosted above strong raw
    expect(ranked[0]?.global).toBe(true); // and correctly tagged as a global-brain hit
    expect(ranked.map((h) => h.observation.id)).toContain(raw); // raw still surfaces (no filter)
  });
});

describe('recall (hybrid) — kind-weighted re-rank (#143)', () => {
  let bdir: string;
  let store: MemoryStore;
  let recall: Recall;
  let sessionId: number;

  // Deterministic vector leg: the provider returns a FIXED query vector regardless of the
  // text, and each doc's vector is seeded by hand (see `add`), so the hybrid fusion is fully
  // controlled. Hot dimension 0 = "close to query"; any other = "far".
  const Q = unit(0);
  const stub: EmbeddingProvider = {
    id: 'stub',
    model: 'none',
    dimensions: 8,
    embed: async (texts: string[]) => texts.map(() => Q),
  };

  // Filler tokens (don't match any query) make a durable doc's bm25 weak so FTS ranks it
  // last — the kind weight still has to lift it. Mirrors the #141 suite's FILLER.
  const FILLER = Array.from({ length: 40 }, (_, i) => `filler${i}`).join(' ');

  function unit(hot: number): number[] {
    const v = new Array<number>(8).fill(0);
    v[hot] = 1;
    return v;
  }

  beforeEach(() => {
    bdir = mkdtempSync(join(tmpdir(), 'abs-recall-hybrid-'));
    store = new MemoryStore({ dbPath: join(bdir, 'm.db'), dimensions: 8 }).open();
    recall = new Recall(store, stub);
    sessionId = store.createSession({ externalId: 's1' });
  });

  afterEach(() => {
    store.close();
    rmSync(bdir, { recursive: true, force: true });
  });

  /** Seed an observation into BOTH the FTS index and the vector index (hybrid needs both). */
  function add(kind: string, content: string, vec: number[]): number {
    const id = store.createObservation({ sessionId, kind, content });
    store.indexFts(id, content);
    store.upsertVector(id, vec);
    return id;
  }

  it('lifts a durable hit above a stronger-fused raw turn (hybrid)', async () => {
    // raw: strong on BOTH legs (exact terms + vector = query). durable: weak on both.
    const raw = add('user', 'alpha alpha alpha', Q);
    const durable = add('lesson', `alpha ${FILLER}`, unit(4));

    const off = (await recall.recall('alpha', { limit: 5 })).map((h) => h.observation.id);
    expect(off[0]).toBe(raw); // fused order: strong raw first

    const on = await recall.recall('alpha', { limit: 5, rankByKind: true });
    expect(on[0]?.observation.id).toBe(durable); // kind weight lifts the durable to the top
    expect(on.map((h) => h.observation.id)).toContain(raw); // NOT a filter — raw still present
  });

  it('keeps `score` = the raw fused RRF value even when rankByKind (wire contract)', async () => {
    const raw = add('user', 'beta beta beta', Q);
    add('lesson', `beta ${FILLER}`, unit(4));

    // Same query both ways; the fused score for a given id must be identical — the weight
    // changes ORDER only, never the serialized score (Codex review on PR / #143 contract).
    const plain = await recall.recall('beta', { limit: 5 });
    const ranked = await recall.recall('beta', { limit: 5, rankByKind: true });
    const rawPlain = plain.find((h) => h.observation.id === raw)?.score;
    const rawRanked = ranked.find((h) => h.observation.id === raw)?.score;
    expect(rawRanked).toBe(rawPlain); // byte-identical fused score; not multiplied by the weight
  });

  it('rankByKind off (default) is byte-identical order AND score', async () => {
    add('user', 'gamma gamma gamma', Q);
    add('lesson', `gamma ${FILLER}`, unit(4));

    const omitted = await recall.recall('gamma', { limit: 5 });
    const explicitFalse = await recall.recall('gamma', { limit: 5, rankByKind: false });
    expect(explicitFalse.map((h) => h.observation.id)).toEqual(
      omitted.map((h) => h.observation.id),
    );
    expect(explicitFalse.map((h) => h.score)).toEqual(omitted.map((h) => h.score));
  });

  it('re-ranks the WHOLE pool — a durable hit DEEP in the pool is not truncated away', async () => {
    // 7 strong raw matches push the weak durable far down the fused pool (well past a naive
    // limit×factor window at limit:1). Full-pool re-rank must still surface it.
    for (let i = 0; i < 7; i++) add('user', `delta delta delta raw${i}`, Q);
    const durable = add('lesson', `delta ${FILLER}`, unit(4));

    expect((await recall.recall('delta', { limit: 1 })).map((h) => h.observation.id)).not.toContain(
      durable,
    ); // pure fused at limit 1 → a strong raw, durable is deep
    expect((await recall.recall('delta', { limit: 1, rankByKind: true }))[0]?.observation.id).toBe(
      durable,
    ); // full-pool weight surfaces the deep durable
  });

  it('no durable in the pool → rankByKind is a no-op (order unchanged)', async () => {
    add('user', 'epsilon epsilon epsilon', Q);
    add('assistant', 'epsilon epsilon', unit(1));
    add('user', 'epsilon zeta', unit(2));

    const off = (await recall.recall('epsilon', { limit: 5 })).map((h) => h.observation.id);
    const on = (await recall.recall('epsilon', { limit: 5, rankByKind: true })).map(
      (h) => h.observation.id,
    );
    expect(on).toEqual(off); // all weights 1 → identical order
  });
});

describe('MemoryStore.kindsByIds — batched id→kind (#143)', () => {
  let kdir: string;
  let store: MemoryStore;
  beforeEach(() => {
    kdir = mkdtempSync(join(tmpdir(), 'abs-kinds-'));
    store = new MemoryStore({ dbPath: join(kdir, 'm.db'), dimensions: 8 }).open();
  });
  afterEach(() => {
    store.close();
    rmSync(kdir, { recursive: true, force: true });
  });

  it('resolves kinds for present ids, omits absent ones, and never emits IN ()', () => {
    const s = store.createSession({ externalId: 's1' });
    const a = store.createObservation({ sessionId: s, kind: 'lesson', content: 'x' });
    const b = store.createObservation({ sessionId: s, kind: 'user', content: 'y' });

    expect(store.kindsByIds([])).toEqual(new Map()); // empty → no query, no IN () crash
    const got = store.kindsByIds([a, b, 999999]); // 999999 is absent (index drift)
    expect(got.get(a)).toBe('lesson');
    expect(got.get(b)).toBe('user');
    expect(got.has(999999)).toBe(false); // absent id simply omitted
  });
});

describe('recall noise floor (#144)', () => {
  let bdir: string;
  let store: MemoryStore;
  let sessionId: number;

  const Q = unitVec(0);
  // Returns a fixed query vector so the hybrid vector leg is fully controlled.
  const stub: EmbeddingProvider = {
    id: 'stub',
    model: 'none',
    dimensions: 8,
    embed: async (texts: string[]) => texts.map(() => Q),
  };

  function unitVec(hot: number): number[] {
    const v = new Array<number>(8).fill(0);
    v[hot] = 1;
    return v;
  }

  beforeEach(() => {
    bdir = mkdtempSync(join(tmpdir(), 'abs-floor-'));
    store = new MemoryStore({ dbPath: join(bdir, 'm.db'), dimensions: 8 }).open();
    sessionId = store.createSession({ externalId: 's1' });
  });
  afterEach(() => {
    store.close();
    rmSync(bdir, { recursive: true, force: true });
  });

  function add(kind: string, content: string, vec?: number[]): number {
    const id = store.createObservation({ sessionId, kind, content });
    store.indexFts(id, content);
    if (vec) store.upsertVector(id, vec);
    return id;
  }

  it('recallFts: drops a best-of-the-junk hit (1-of-many token overlap) → []', () => {
    const recall = new Recall(store, stub);
    // Only doc matches ONE of the four query content-tokens (coverage 0.25 < 0.4).
    add('user', 'bread recipe notes');
    const q = 'sourdough bread fermentation hydration';
    expect(recall.recallFts(q, { limit: 5 })).toHaveLength(1); // default: junk surfaces
    expect(recall.recallFts(q, { limit: 5, rankByKind: true, noiseFloor: true })).toEqual([]);
  });

  it('recallFts: keeps a hit that clears the coverage floor', () => {
    const recall = new Recall(store, stub);
    const good = add('lesson', 'coupa oauth migration client credentials grant');
    const hits = recall.recallFts('coupa oauth migration', {
      limit: 5,
      rankByKind: true,
      noiseFloor: true,
    });
    expect(hits.map((h) => h.observation.id)).toEqual([good]);
  });

  it('recallFts noiseFloor does NOT re-rank by kind unless asked (pure FTS order + floor)', () => {
    const recall = new Recall(store, stub);
    const raw = add('user', 'alpha alpha alpha'); // strong, covers the query
    add('lesson', 'alpha beta gamma delta'); // weaker FTS, also covers "alpha"
    // floor only (no rankByKind): the strong raw match stays on top (no durable lift).
    const hits = recall.recallFts('alpha', { limit: 5, noiseFloor: true });
    expect(hits[0]?.observation.id).toBe(raw);
  });

  it('recall (hybrid): drops junk (low coverage + weak cosine) but keeps a semantic paraphrase', async () => {
    const recall = new Recall(store, stub);
    // Junk: matches one token, vector far from Q (orthogonal → cosine 0).
    add('user', 'bread recipe', unitVec(4));
    // Paraphrase: low literal overlap with the query but vector == Q (cosine 1) → kept.
    const para = add('lesson', 'git rebase interactive squashes commits', Q);
    const hits = await recall.recall('squash several commits version control', {
      limit: 5,
      rankByKind: true,
      noiseFloor: true,
    });
    const ids = hits.map((h) => h.observation.id);
    expect(ids).toContain(para); // semantic match survives the floor on cosine
    expect(hits.every((h) => h.observation.content !== 'bread recipe')).toBe(true); // junk dropped
  });

  it('recall (hybrid): a query with no relevant memory returns []', async () => {
    const recall = new Recall(store, stub);
    add('user', 'completely unrelated content here', unitVec(4)); // far vector, no token overlap
    const hits = await recall.recall('quantum chromodynamics gluon confinement', {
      limit: 5,
      rankByKind: true,
      noiseFloor: true,
    });
    expect(hits).toEqual([]);
  });
});
