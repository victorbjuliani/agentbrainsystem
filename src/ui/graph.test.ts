import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../store/index.js';
import { buildGraph, NODE_CAP } from './graph.js';
import { GRAPH_CONTRACT_VERSION } from './graph-types.js';

const DIM = 8;

/** Deterministic unit vector with a single hot dimension. */
function unitVector(hot: number, dim = DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  v[hot % dim] = 1;
  return v;
}

describe('buildGraph', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore({ dbPath: ':memory:', dimensions: DIM }).open();
  });

  afterEach(() => {
    store.close();
  });

  it('returns a valid empty GraphData for an empty store', () => {
    const g = buildGraph(store, {});
    expect(g.version).toBe(GRAPH_CONTRACT_VERSION);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.meta.emptyStore).toBe(true);
    expect(g.meta.renderedNodes).toBe(0);
  });

  it('builds containment edges with namespaced ids for a session', () => {
    const s = store.createSession({ externalId: 'sess', project: 'proj' });
    const a = store.createObservation({ sessionId: s, kind: 'user', content: 'hi' });
    store.createObservation({ sessionId: s, kind: 'assistant', content: 'hello back' });

    const g = buildGraph(store, { session: s });
    const sessionNode = g.nodes.find((n) => n.id === `s:${s}`);
    expect(sessionNode?.type).toBe('session');
    expect(sessionNode?.label).toBe('proj');
    expect(g.nodes.find((n) => n.id === `o:${a}`)?.type).toBe('user');

    // every observation is connected to the session by a containment edge weight 1.
    const containment = g.edges.filter((e) => e.kind === 'containment');
    expect(containment).toHaveLength(2);
    for (const e of containment) {
      expect(e.source).toBe(`s:${s}`);
      expect(e.weight).toBe(1);
    }
    expect(g.edges.every((e) => e.kind === 'containment')).toBe(true);
  });

  it('emits only kinds present in the data', () => {
    const s = store.createSession({ externalId: 'sess' });
    store.createObservation({ sessionId: s, kind: 'user', content: 'q' });
    const g = buildGraph(store, { session: s });
    const types = new Set(g.nodes.map((n) => n.type));
    expect(types.has('user')).toBe(true);
    expect(types.has('assistant')).toBe(false);
  });

  it('handles an UNKNOWN kind without crashing (falls back to tool)', () => {
    const s = store.createSession({ externalId: 'sess' });
    const note = store.createObservation({ sessionId: s, kind: 'note', content: 'odd kind' });
    const g = buildGraph(store, { session: s });
    expect(g.nodes.find((n) => n.id === `o:${note}`)?.type).toBe('tool');
  });

  it('default scope picks the most recently active session', () => {
    const older = store.createSession({ externalId: 'older', project: 'older' });
    const newer = store.createSession({ externalId: 'newer', project: 'newer' });
    store.createObservation({
      sessionId: older,
      kind: 'user',
      content: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    store.createObservation({
      sessionId: newer,
      kind: 'user',
      content: 'b',
      createdAt: '2026-05-01T00:00:00.000Z',
    });

    const g = buildGraph(store, {});
    expect(g.scope.mode).toBe('session');
    expect(g.scope.sessionId).toBe(newer);
    expect(g.nodes.some((n) => n.id === `s:${newer}`)).toBe(true);
    expect(g.nodes.some((n) => n.id === `s:${older}`)).toBe(false);
  });

  it('clamps a request limit larger than NODE_CAP', () => {
    const s = store.createSession({ externalId: 'sess' });
    for (let i = 0; i < 5; i++) {
      store.createObservation({ sessionId: s, kind: 'user', content: `m${i}` });
    }
    const g = buildGraph(store, { session: s, limit: NODE_CAP + 5000 });
    expect(g.scope.limit).toBe(NODE_CAP);
    expect(g.nodes.length).toBeLessThanOrEqual(NODE_CAP);
  });

  it('caps node count even for an enormous request on a large store', () => {
    const s = store.createSession({ externalId: 'sess' });
    for (let i = 0; i < NODE_CAP + 50; i++) {
      store.createObservation({ sessionId: s, kind: 'user', content: `m${i}` });
    }
    const g = buildGraph(store, { session: s, limit: 1_000_000 });
    expect(g.nodes.length).toBeLessThanOrEqual(NODE_CAP);
    expect(g.meta.truncated).toBe(true);
  });

  it('topN renders the MOST RECENT observations store-wide, not the oldest (C1)', () => {
    // Seed > NODE_CAP observations so the naive "fetch lowest NODE_CAP ids then
    // tail-slice" path can never reach the newest rows.
    const s = store.createSession({ externalId: 'sess', project: 'proj' });
    const ids: number[] = [];
    for (let i = 0; i < NODE_CAP + 50; i++) {
      ids.push(store.createObservation({ sessionId: s, kind: 'user', content: `m${i}` }));
    }
    const highest = Math.max(...ids);
    const lowest = Math.min(...ids);

    const g = buildGraph(store, { topN: 20 });
    expect(g.scope.mode).toBe('topN');

    const renderedObsIds = new Set(
      g.nodes.filter((n) => n.id.startsWith('o:')).map((n) => Number(n.id.slice(2))),
    );
    // The newest observation MUST be present; the oldest MUST be absent.
    expect(renderedObsIds.has(highest)).toBe(true);
    expect(renderedObsIds.has(lowest)).toBe(false);
  });

  it('topN respects the budget and sets mode/truncated correctly', () => {
    const s = store.createSession({ externalId: 'sess', project: 'proj' });
    for (let i = 0; i < 50; i++) {
      store.createObservation({ sessionId: s, kind: 'user', content: `m${i}` });
    }
    const g = buildGraph(store, { topN: 20 });
    expect(g.scope.mode).toBe('topN');
    const obsNodes = g.nodes.filter((n) => n.id.startsWith('o:'));
    expect(obsNodes).toHaveLength(20); // exactly min(topN, available)
    expect(g.meta.truncated).toBe(true); // 50 available, 20 rendered

    // When topN exceeds available, render all and do not over-truncate on obs count.
    const g2 = buildGraph(store, { topN: 1000 });
    const obsNodes2 = g2.nodes.filter((n) => n.id.startsWith('o:'));
    expect(obsNodes2).toHaveLength(50);
  });

  it('produces no similarity edges when similarity is off', () => {
    const s = store.createSession({ externalId: 'sess' });
    const a = store.createObservation({ sessionId: s, kind: 'user', content: 'alpha' });
    const b = store.createObservation({ sessionId: s, kind: 'user', content: 'beta' });
    store.upsertVector(a, unitVector(0));
    store.upsertVector(b, unitVector(0));
    const g = buildGraph(store, { session: s });
    expect(g.edges.some((e) => e.kind === 'similarity')).toBe(false);
  });

  it('produces bounded, deduped similarity edges from stored vectors', () => {
    const s = store.createSession({ externalId: 'sess' });
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const id = store.createObservation({ sessionId: s, kind: 'user', content: `m${i}` });
      store.upsertVector(id, unitVector(0)); // all identical → mutually near
      ids.push(id);
    }
    const g = buildGraph(store, { session: s, similarity: true });
    const sim = g.edges.filter((e) => e.kind === 'similarity');
    expect(sim.length).toBeGreaterThan(0);
    // No symmetric duplicates.
    const keys = sim.map((e) =>
      e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    // weights normalized to [0,1].
    for (const e of sim) {
      expect(e.weight).toBeGreaterThanOrEqual(0);
      expect(e.weight).toBeLessThanOrEqual(1);
    }
    expect(g.scope.similarity).toBe(true);
  });

  // ---- Pinned consolidated nodes (#35) --------------------------------------

  it('pins lesson/decision into view even when the session scope cuts the newest obs', () => {
    const s = store.createSession({ externalId: 'sess', project: 'proj' });
    // Bury the session past NODE_CAP with plain turns (oldest ids stay in the
    // id-ASC scope window; the newest get sliced out).
    for (let i = 0; i < NODE_CAP + 50; i++) {
      store.createObservation({ sessionId: s, kind: 'user', content: `m${i}` });
    }
    // The durable consolidate output is written LAST → highest ids → would fall
    // below the recency cut without pinning (the #35 bug).
    const lessonId = store.createObservation({ sessionId: s, kind: 'lesson', content: 'L' });
    const decisionId = store.createObservation({ sessionId: s, kind: 'decision', content: 'D' });

    const g = buildGraph(store, { session: s });
    const obsIds = new Set(
      g.nodes.filter((n) => n.id.startsWith('o:')).map((n) => Number(n.id.slice(2))),
    );
    expect(obsIds.has(lessonId)).toBe(true);
    expect(obsIds.has(decisionId)).toBe(true);
    expect(g.nodes.length).toBeLessThanOrEqual(NODE_CAP);
  });

  it('surfaces consolidated nodes from OTHER sessions (with their session hub) in session scope', () => {
    const focus = store.createSession({ externalId: 'focus', project: 'focus' });
    store.createObservation({ sessionId: focus, kind: 'user', content: 'q' });
    const other = store.createSession({ externalId: 'other', project: 'other' });
    const lessonId = store.createObservation({
      sessionId: other,
      kind: 'lesson',
      content: 'cross',
    });

    const g = buildGraph(store, { session: focus });
    const obsIds = new Set(
      g.nodes.filter((n) => n.id.startsWith('o:')).map((n) => Number(n.id.slice(2))),
    );
    expect(obsIds.has(lessonId)).toBe(true);
    // The other session's hub must be present so the pin is not an orphan.
    expect(g.nodes.some((n) => n.id === `s:${other}`)).toBe(true);
  });

  it('does not duplicate a pinned obs that is already in scope', () => {
    const s = store.createSession({ externalId: 'sess' });
    const lessonId = store.createObservation({ sessionId: s, kind: 'lesson', content: 'L' });
    const g = buildGraph(store, { session: s });
    expect(g.nodes.filter((n) => n.id === `o:${lessonId}`)).toHaveLength(1);
  });

  it('session mode ignores project for pins — cross-session surfacing preserved (#129 Codex)', () => {
    // parseGraphQuery allows session+project together. Session mode ignores project
    // for its own window, so its pins must too — a non-matching project must NOT hide
    // the intentional cross-session pin surfacing (#35).
    const focus = store.createSession({ externalId: 'focus', project: 'proj-a' });
    store.createObservation({ sessionId: focus, kind: 'user', content: 'q' });
    const other = store.createSession({ externalId: 'other', project: 'proj-b' });
    const lessonId = store.createObservation({
      sessionId: other,
      kind: 'lesson',
      content: 'B lesson pinned',
    });

    const g = buildGraph(store, { session: focus, project: 'proj-a' });
    const obsIds = new Set(g.nodes.filter((n) => n.type !== 'session').map((n) => n.id));
    expect(obsIds.has(`o:${lessonId}`)).toBe(true); // pin from proj-b still surfaces
  });

  it('UI search matches word variants via prefix — migrat → Migrations (#129)', () => {
    const s = store.createSession({ externalId: 'sess', project: 'p' });
    const o = store.createObservation({
      sessionId: s,
      kind: 'lesson',
      content: 'Migrations are forward-only',
    });
    store.indexFts(o, 'Migrations are forward-only'); // FTS is indexer-populated; seed it directly
    const g = buildGraph(store, { search: 'migrat' });
    expect(g.scope.mode).toBe('search');
    // Exact FTS would miss the singular stem; the UI search opts into prefix matching.
    expect(g.nodes.some((n) => n.id === `o:${o}`)).toBe(true);
  });

  it('scopes pins to the selected project — no cross-project leak in topN (#129)', () => {
    // Project A has the consolidated pins (lesson/decision); project B has only a note.
    const sa = store.createSession({ externalId: 'A', project: 'proj-a' });
    store.createObservation({ sessionId: sa, kind: 'decision', content: 'A decision' });
    store.createObservation({ sessionId: sa, kind: 'lesson', content: 'A lesson' });
    const sb = store.createSession({ externalId: 'B', project: 'proj-b' });
    const bNote = store.createObservation({ sessionId: sb, kind: 'note', content: 'B note' });

    const g = buildGraph(store, { topN: 200, project: 'proj-b' });
    const obsNodes = g.nodes.filter((n) => n.type !== 'session');
    // Only project B's observation may appear — A's pinned lesson/decision must NOT leak.
    expect(obsNodes.map((n) => n.id)).toEqual([`o:${bNote}`]);

    // And the inverse: project A still sees its own pins (no over-filtering).
    const ga = buildGraph(store, { topN: 200, project: 'proj-a' });
    const aTypes = new Set(ga.nodes.filter((n) => n.type !== 'session').map((n) => n.type));
    expect(aTypes.has('lesson')).toBe(true);
    expect(aTypes.has('decision')).toBe(true);
  });

  it('enforces the requested limit even after pinning consolidated nodes (#42 P1)', () => {
    const s = store.createSession({ externalId: 'sess', project: 'proj' });
    for (let i = 0; i < 30; i++) {
      store.createObservation({ sessionId: s, kind: 'user', content: `m${i}` });
    }
    // Consolidated nodes (highest ids) would be pinned ahead of the scope set.
    store.createObservation({ sessionId: s, kind: 'lesson', content: 'L1' });
    store.createObservation({ sessionId: s, kind: 'decision', content: 'D1' });

    const g = buildGraph(store, { session: s, limit: 10 });
    expect(g.scope.limit).toBe(10);
    // The per-request budget is honored even though pins were prepended.
    expect(g.nodes.length).toBeLessThanOrEqual(10);
    // Pins win the budget over the scope tail (they render first).
    const types = new Set(g.nodes.map((n) => n.type));
    expect(types.has('lesson')).toBe(true);
    expect(types.has('decision')).toBe(true);
  });

  it('caps pinned-hub footprint so pinned obs still render under a small limit (#42 P2)', () => {
    const focus = store.createSession({ externalId: 'focus', project: 'focus' });
    store.createObservation({ sessionId: focus, kind: 'user', content: 'q' });
    // 12 OTHER sessions, each with a single lesson → each pin needs its own hub.
    // Without a footprint cap, the hubs alone would fill a small budget and the
    // lessons would never render (only session hubs would).
    for (let i = 0; i < 12; i++) {
      const s = store.createSession({ externalId: `o${i}` });
      store.createObservation({ sessionId: s, kind: 'lesson', content: `L${i}` });
    }
    const g = buildGraph(store, { session: focus, limit: 8 });
    expect(g.nodes.length).toBeLessThanOrEqual(8);
    // At least one pinned lesson OBS renders — hubs don't consume the whole budget.
    expect(g.nodes.some((n) => n.type === 'lesson')).toBe(true);
  });

  // ---- Search mode (#35) ----------------------------------------------------

  it('search resolves FTS matches store-wide, ignoring scope/recency', () => {
    const s1 = store.createSession({ externalId: 's1', project: 'p1' });
    const s2 = store.createSession({ externalId: 's2', project: 'p2' });
    const needleId = store.createObservation({
      sessionId: s1,
      kind: 'user',
      content: 'unicorn needle',
    });
    store.indexFts(needleId, 'unicorn needle');
    const otherId = store.createObservation({ sessionId: s2, kind: 'user', content: 'plain hay' });
    store.indexFts(otherId, 'plain hay');

    const g = buildGraph(store, { search: 'unicorn' });
    expect(g.scope.mode).toBe('search');
    const obsIds = new Set(
      g.nodes.filter((n) => n.id.startsWith('o:')).map((n) => Number(n.id.slice(2))),
    );
    expect(obsIds.has(needleId)).toBe(true);
    expect(obsIds.has(otherId)).toBe(false);
    expect(g.nodes.some((n) => n.id === `s:${s1}`)).toBe(true);
  });

  it('search reaches obs OUTSIDE the recency window (the #35 bug)', () => {
    const s = store.createSession({ externalId: 'sess' });
    // Oldest obs holds the needle; bury it under NODE_CAP newer turns.
    const needleId = store.createObservation({
      sessionId: s,
      kind: 'user',
      content: 'buried zebra',
    });
    store.indexFts(needleId, 'buried zebra');
    for (let i = 0; i < NODE_CAP + 50; i++) {
      const id = store.createObservation({ sessionId: s, kind: 'user', content: `noise ${i}` });
      store.indexFts(id, `noise ${i}`);
    }
    const g = buildGraph(store, { search: 'zebra' });
    const obsIds = new Set(
      g.nodes.filter((n) => n.id.startsWith('o:')).map((n) => Number(n.id.slice(2))),
    );
    expect(obsIds.has(needleId)).toBe(true);
  });

  it('non-searchable query (punctuation-only) yields an empty search graph, not a 500', () => {
    const s = store.createSession({ externalId: 'sess' });
    const id = store.createObservation({ sessionId: s, kind: 'user', content: 'hello' });
    store.indexFts(id, 'hello');
    const g = buildGraph(store, { search: '   ?! - ' });
    expect(g.scope.mode).toBe('search');
    expect(g.nodes).toEqual([]);
    expect(g.meta.emptyStore).toBe(false);
  });

  it('zero-hit search on a populated store reports search mode + non-empty store', () => {
    const s = store.createSession({ externalId: 'sess' });
    const id = store.createObservation({ sessionId: s, kind: 'user', content: 'hello world' });
    store.indexFts(id, 'hello world');
    const g = buildGraph(store, { search: 'nonexistentxyz' });
    expect(g.scope.mode).toBe('search');
    expect(g.nodes).toEqual([]);
    expect(g.meta.emptyStore).toBe(false);
  });

  it('reserves observation slots in search so hits render under a small limit (#42 P2)', () => {
    // 10 distinct sessions, each with one matching obs → without interleaving the
    // hubs alone would fill a small budget and zero hits would render.
    for (let i = 0; i < 10; i++) {
      const s = store.createSession({ externalId: `s${i}` });
      const id = store.createObservation({ sessionId: s, kind: 'user', content: `findme ${i}` });
      store.indexFts(id, `findme ${i}`);
    }
    const g = buildGraph(store, { search: 'findme', limit: 8 });
    expect(g.scope.mode).toBe('search');
    expect(g.nodes.length).toBeLessThanOrEqual(8);
    // Matched OBS render — not just session hubs.
    expect(g.nodes.some((n) => n.id.startsWith('o:'))).toBe(true);
  });

  it('search takes precedence over topN/session', () => {
    const s = store.createSession({ externalId: 'sess' });
    const id = store.createObservation({ sessionId: s, kind: 'user', content: 'findme token' });
    store.indexFts(id, 'findme token');
    const g = buildGraph(store, { search: 'findme', topN: 5, session: 99999 });
    expect(g.scope.mode).toBe('search');
    expect(g.nodes.some((n) => n.id === `o:${id}`)).toBe(true);
  });
});

describe('buildGraph — store-wide project picker (#62 follow-up B)', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore({ dbPath: ':memory:', dimensions: DIM }).open();
  });
  afterEach(() => {
    store.close();
  });

  it('meta.projects lists every distinct non-null project, sorted, store-wide', () => {
    const beta = store.createSession({ externalId: 'b', project: 'beta' });
    const alpha = store.createSession({ externalId: 'a', project: 'alpha' });
    store.createSession({ externalId: 'n' }); // NULL project — excluded
    store.createObservation({ sessionId: beta, kind: 'user', content: 'x' });
    store.createObservation({ sessionId: alpha, kind: 'user', content: 'y' });

    // Even in single-session scope, the picker list is the FULL store-wide set.
    const g = buildGraph(store, { session: beta });
    expect(g.meta.projects).toEqual(['alpha', 'beta']);
  });

  it('meta.projects is an empty array on an empty store', () => {
    expect(buildGraph(store, {}).meta.projects).toEqual([]);
  });

  it('topN + project restricts the rendered window to that project only', () => {
    const home = store.createSession({ externalId: 'home', project: 'home' });
    const chess = store.createSession({ externalId: 'chess', project: 'chess' });
    const h = store.createObservation({ sessionId: home, kind: 'user', content: 'home obs' });
    const c = store.createObservation({ sessionId: chess, kind: 'user', content: 'chess obs' });

    const g = buildGraph(store, { topN: 200, project: 'chess' });
    expect(g.scope.mode).toBe('topN');
    expect(g.scope.project).toBe('chess');
    // Only the chess observation + its session hub render; home is filtered out.
    expect(g.nodes.some((n) => n.id === `o:${c}`)).toBe(true);
    expect(g.nodes.some((n) => n.id === `o:${h}`)).toBe(false);
    expect(g.nodes.some((n) => n.id === `s:${chess}`)).toBe(true);
    expect(g.nodes.some((n) => n.id === `s:${home}`)).toBe(false);
  });

  it('topN without a project stays store-wide (project filter is opt-in)', () => {
    const home = store.createSession({ externalId: 'home', project: 'home' });
    const chess = store.createSession({ externalId: 'chess', project: 'chess' });
    const h = store.createObservation({ sessionId: home, kind: 'user', content: 'home obs' });
    const c = store.createObservation({ sessionId: chess, kind: 'user', content: 'chess obs' });

    const g = buildGraph(store, { topN: 200 });
    expect(g.scope.project).toBeUndefined();
    expect(g.nodes.some((n) => n.id === `o:${h}`)).toBe(true);
    expect(g.nodes.some((n) => n.id === `o:${c}`)).toBe(true);
  });

  it('topN + a project with no observations resolves to zero nodes (not empty store)', () => {
    const home = store.createSession({ externalId: 'home', project: 'home' });
    store.createObservation({ sessionId: home, kind: 'user', content: 'home obs' });

    const g = buildGraph(store, { topN: 200, project: 'ghost' });
    expect(g.nodes).toEqual([]);
    expect(g.meta.emptyStore).toBe(false); // store is populated — just not for this project
    expect(g.meta.projects).toEqual(['home']);
  });
});
