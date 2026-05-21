import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';

const DIM = 384;

/** A deterministic unit vector of length DIM with a single hot dimension. */
function unitVector(hot: number, dim = DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  v[hot % dim] = 1;
  return v;
}

describe('MemoryStore', () => {
  let dir: string;
  let dbPath: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-store-'));
    dbPath = join(dir, 'memory.db');
    store = new MemoryStore({ dbPath, dimensions: DIM });
    store.open();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('migrations', () => {
    it('runs migrations on open and records the current version', () => {
      expect(store.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('is idempotent — reopening the same db keeps version stable, no error', () => {
      const v1 = store.schemaVersion();
      store.close();

      const reopened = new MemoryStore({ dbPath, dimensions: DIM });
      reopened.open();
      expect(reopened.schemaVersion()).toBe(v1);
      // runMigrations again explicitly: still a no-op.
      reopened.runMigrations();
      expect(reopened.schemaVersion()).toBe(v1);
      reopened.close();
    });

    it('creates the dbPath directory if missing', () => {
      const nested = join(dir, 'a', 'b', 'c', 'mem.db');
      const s = new MemoryStore({ dbPath: nested, dimensions: DIM });
      s.open();
      expect(s.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
      s.close();
    });
  });

  describe('session CRUD', () => {
    it('creates and reads back a session', () => {
      const id = store.createSession({
        externalId: 'sess-1',
        project: 'agentbrainsystem',
        meta: { harness: 'claude-code' },
      });
      expect(typeof id).toBe('number');

      const got = store.getSession(id);
      expect(got).not.toBeNull();
      expect(got?.externalId).toBe('sess-1');
      expect(got?.project).toBe('agentbrainsystem');
      expect(got?.meta).toEqual({ harness: 'claude-code' });
      expect(typeof got?.createdAt).toBe('string');
    });

    it('finds a session by externalId and enforces uniqueness', () => {
      const id = store.createSession({ externalId: 'dup', project: 'p' });
      const found = store.getSessionByExternalId('dup');
      expect(found?.id).toBe(id);
      expect(() => store.createSession({ externalId: 'dup', project: 'p' })).toThrow();
    });

    it('lists sessions and deletes them', () => {
      store.createSession({ externalId: 's-a', project: 'p' });
      store.createSession({ externalId: 's-b', project: 'p' });
      expect(store.listSessions()).toHaveLength(2);

      const target = store.getSessionByExternalId('s-a');
      expect(target).not.toBeNull();
      store.deleteSession(target?.id ?? -1);
      expect(store.listSessions()).toHaveLength(1);
    });
  });

  describe('observation CRUD', () => {
    let sessionId: number;
    beforeEach(() => {
      sessionId = store.createSession({ externalId: 'sess', project: 'p' });
    });

    it('creates and reads back an observation', () => {
      const obsId = store.createObservation({
        sessionId,
        kind: 'decision',
        content: 'use sqlite-vec for the vector index',
        metadata: { confidence: 0.9 },
        source: 'test',
      });
      const got = store.getObservation(obsId);
      expect(got?.sessionId).toBe(sessionId);
      expect(got?.kind).toBe('decision');
      expect(got?.content).toContain('sqlite-vec');
      expect(got?.metadata).toEqual({ confidence: 0.9 });
      expect(got?.source).toBe('test');
    });

    it('lists observations by session and supports a limit', () => {
      for (let i = 0; i < 5; i++) {
        store.createObservation({ sessionId, kind: 'user', content: `msg ${i}` });
      }
      expect(store.listObservations({ sessionId })).toHaveLength(5);
      expect(store.listObservations({ sessionId, limit: 2 })).toHaveLength(2);
    });

    it('lists observations id-ASC by default and id-DESC when order=desc', () => {
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(store.createObservation({ sessionId, kind: 'user', content: `msg ${i}` }));
      }
      // Default (no order) stays id-ASC — existing callers unchanged.
      const asc = store.listObservations({ sessionId }).map((o) => o.id);
      expect(asc).toEqual([...ids].sort((a, b) => a - b));

      // order='desc' returns rows in id-DESC order.
      const desc = store.listObservations({ sessionId, order: 'desc' }).map((o) => o.id);
      expect(desc).toEqual([...ids].sort((a, b) => b - a));

      // desc + limit returns the NEWEST rows (highest ids).
      const newest = store
        .listObservations({ sessionId, order: 'desc', limit: 2 })
        .map((o) => o.id);
      expect(newest).toEqual([...ids].sort((a, b) => b - a).slice(0, 2));
    });

    it('iterates observations without materializing the whole set', () => {
      for (let i = 0; i < 3; i++) {
        store.createObservation({ sessionId, kind: 'user', content: `m${i}` });
      }
      const seen: string[] = [];
      for (const obs of store.iterateObservations()) seen.push(obs.content);
      expect(seen).toHaveLength(3);
    });
  });

  describe('listSessionsByActivity', () => {
    it('orders sessions by latest observation activity, most-active first', () => {
      // s1 created first but its newest obs is older; s2 created later with a fresher obs.
      const s1 = store.createSession({ externalId: 's1', project: 'p' });
      const s2 = store.createSession({ externalId: 's2', project: 'p' });
      store.createObservation({
        sessionId: s1,
        kind: 'user',
        content: 'old',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      store.createObservation({
        sessionId: s1,
        kind: 'user',
        content: 'mid',
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      store.createObservation({
        sessionId: s2,
        kind: 'user',
        content: 'newest',
        createdAt: '2026-03-01T00:00:00.000Z',
      });

      const ordered = store.listSessionsByActivity();
      expect(ordered.map((s) => s.id)).toEqual([s2, s1]);
    });

    it('honours the limit and returns only the most-active sessions', () => {
      const s1 = store.createSession({ externalId: 's1' });
      const s2 = store.createSession({ externalId: 's2' });
      store.createObservation({
        sessionId: s1,
        kind: 'user',
        content: 'a',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      store.createObservation({
        sessionId: s2,
        kind: 'user',
        content: 'b',
        createdAt: '2026-02-01T00:00:00.000Z',
      });
      const top = store.listSessionsByActivity(1);
      expect(top).toHaveLength(1);
      expect(top[0]?.id).toBe(s2);
    });

    it('sorts zero-observation sessions last', () => {
      const empty = store.createSession({ externalId: 'empty' });
      const active = store.createSession({ externalId: 'active' });
      store.createObservation({
        sessionId: active,
        kind: 'user',
        content: 'x',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const ordered = store.listSessionsByActivity();
      expect(ordered.map((s) => s.id)).toEqual([active, empty]);
    });

    it('keeps listSessions() byte-for-byte (id ASC, all rows) intact', () => {
      const s1 = store.createSession({ externalId: 's1' });
      const s2 = store.createSession({ externalId: 's2' });
      store.createObservation({
        sessionId: s1,
        kind: 'user',
        content: 'fresh',
        createdAt: '2026-05-01T00:00:00.000Z',
      });
      // listSessions stays id-ASC regardless of activity.
      expect(store.listSessions().map((s) => s.id)).toEqual([s1, s2]);
    });
  });

  describe('vector index primitives', () => {
    let sessionId: number;
    beforeEach(() => {
      sessionId = store.createSession({ externalId: 'sess', project: 'p' });
    });

    it('upserts a vector and a KNN query returns the row', () => {
      const a = store.createObservation({ sessionId, kind: 'user', content: 'alpha' });
      const b = store.createObservation({ sessionId, kind: 'user', content: 'beta' });
      store.upsertVector(a, unitVector(0));
      store.upsertVector(b, unitVector(100));

      const hits = store.knn(unitVector(0), 2);
      expect(hits.length).toBe(2);
      expect(hits[0]?.id).toBe(a);
      expect(hits[0]?.distance).toBeLessThan(hits[1]?.distance ?? Infinity);
    });

    it('upsert replaces an existing vector', () => {
      const a = store.createObservation({ sessionId, kind: 'user', content: 'alpha' });
      store.upsertVector(a, unitVector(0));
      store.upsertVector(a, unitVector(50)); // replace
      expect(store.counts().vectors).toBe(1);
      const hits = store.knn(unitVector(50), 1);
      expect(hits[0]?.id).toBe(a);
    });

    it('rejects vectors of the wrong dimension', () => {
      const a = store.createObservation({ sessionId, kind: 'user', content: 'alpha' });
      expect(() => store.upsertVector(a, [1, 2, 3])).toThrow(/dimension/i);
    });

    it('removes a vector', () => {
      const a = store.createObservation({ sessionId, kind: 'user', content: 'alpha' });
      store.upsertVector(a, unitVector(0));
      store.removeVector(a);
      expect(store.counts().vectors).toBe(0);
    });
  });

  describe('FTS primitives', () => {
    let sessionId: number;
    beforeEach(() => {
      sessionId = store.createSession({ externalId: 'sess', project: 'p' });
    });

    it('indexes content and a match returns the row', () => {
      const a = store.createObservation({ sessionId, kind: 'user', content: 'the cat sat' });
      const b = store.createObservation({ sessionId, kind: 'user', content: 'the dog ran' });
      store.indexFts(a, 'the cat sat');
      store.indexFts(b, 'the dog ran');

      const hits = store.searchFts('cat', 5);
      expect(hits.length).toBe(1);
      expect(hits[0]?.id).toBe(a);
    });

    it('reindex replaces prior FTS content for the same row', () => {
      const a = store.createObservation({ sessionId, kind: 'user', content: 'first' });
      store.indexFts(a, 'first');
      store.indexFts(a, 'second'); // replace
      expect(store.searchFts('first', 5)).toHaveLength(0);
      expect(store.searchFts('second', 5)).toHaveLength(1);
      expect(store.counts().fts).toBe(1);
    });

    it('removes an FTS entry', () => {
      const a = store.createObservation({ sessionId, kind: 'user', content: 'gone' });
      store.indexFts(a, 'gone');
      store.removeFts(a);
      expect(store.searchFts('gone', 5)).toHaveLength(0);
      expect(store.counts().fts).toBe(0);
    });
  });

  describe('counts() reflects reality', () => {
    it('reports real observation / vector / fts row counts', () => {
      const sessionId = store.createSession({ externalId: 'sess', project: 'p' });
      const a = store.createObservation({ sessionId, kind: 'user', content: 'alpha' });
      store.createObservation({ sessionId, kind: 'user', content: 'beta' });
      store.upsertVector(a, unitVector(0));
      store.indexFts(a, 'alpha');

      const c = store.counts();
      expect(c.observations).toBe(2);
      expect(c.vectors).toBe(1);
      expect(c.fts).toBe(1);
      expect(c.sessions).toBe(1);
    });
  });

  describe('delete cascades', () => {
    it('deleting an observation removes its vector and fts entries', () => {
      const sessionId = store.createSession({ externalId: 'sess', project: 'p' });
      const a = store.createObservation({ sessionId, kind: 'user', content: 'alpha' });
      store.upsertVector(a, unitVector(0));
      store.indexFts(a, 'alpha');
      expect(store.counts()).toMatchObject({ observations: 1, vectors: 1, fts: 1 });

      store.deleteObservation(a);
      expect(store.counts()).toMatchObject({ observations: 0, vectors: 0, fts: 0 });
    });

    it('deleting a session removes its observations, vectors and fts entries', () => {
      const sessionId = store.createSession({ externalId: 'sess', project: 'p' });
      const a = store.createObservation({ sessionId, kind: 'user', content: 'alpha' });
      const b = store.createObservation({ sessionId, kind: 'user', content: 'beta' });
      store.upsertVector(a, unitVector(0));
      store.upsertVector(b, unitVector(1));
      store.indexFts(a, 'alpha');
      store.indexFts(b, 'beta');

      store.deleteSession(sessionId);
      expect(store.counts()).toMatchObject({
        sessions: 0,
        observations: 0,
        vectors: 0,
        fts: 0,
      });
    });
  });

  describe('pruneIndexOrphans', () => {
    it('removes index rows whose observation no longer exists, keeps live ones', () => {
      const sessionId = store.createSession({ externalId: 'sess' });
      const live = store.createObservation({ sessionId, kind: 'note', content: 'live' });
      store.upsertVector(live, unitVector(0));
      store.indexFts(live, 'live');

      // simulate orphan index rows (e.g. a crash left them behind): no observation row
      store.upsertVector(999, unitVector(1));
      store.indexFts(999, 'ghost');
      expect(store.counts()).toMatchObject({ observations: 1, vectors: 2, fts: 2 });

      store.pruneIndexOrphans();
      expect(store.counts()).toMatchObject({ observations: 1, vectors: 1, fts: 1 });
      // the live entry is still queryable
      expect(store.knn(unitVector(0), 1)[0]?.id).toBe(live);
    });
  });

  describe('listObservationsBySourceSession', () => {
    let sessionId: number;
    beforeEach(() => {
      sessionId = store.createSession({ externalId: 'consolidation-target' });
    });

    it('returns observations tagged with metadata.sourceSession (any source), excluding others', () => {
      // sourceSession=5 with the consolidate source
      const cA = store.createObservation({
        sessionId,
        kind: 'lesson',
        content: 'lesson A from session 5',
        metadata: { sourceSession: 5 },
        source: 'consolidate',
      });
      const cB = store.createObservation({
        sessionId,
        kind: 'decision',
        content: 'decision B from session 5',
        metadata: { sourceSession: 5 },
        source: 'consolidate',
      });
      // sourceSession=5 but a DIFFERENT source (e.g. a user observation that merely carries the field)
      const userTagged = store.createObservation({
        sessionId,
        kind: 'note',
        content: 'user note that happens to carry sourceSession',
        metadata: { sourceSession: 5 },
        source: 'user',
      });
      // sourceSession=5 with absent source (NULL)
      const noSource = store.createObservation({
        sessionId,
        kind: 'note',
        content: 'tagged but no source',
        metadata: { sourceSession: 5 },
      });
      // no metadata at all
      store.createObservation({ sessionId, kind: 'note', content: 'no metadata' });
      // metadata present but no sourceSession field
      store.createObservation({
        sessionId,
        kind: 'note',
        content: 'metadata without sourceSession',
        metadata: { confidence: 0.5 },
      });
      // a different sourceSession
      store.createObservation({
        sessionId,
        kind: 'lesson',
        content: 'lesson from session 7',
        metadata: { sourceSession: 7 },
        source: 'consolidate',
      });

      // No source filter: every row whose metadata.sourceSession === 5, regardless of source.
      const all = store.listObservationsBySourceSession(5);
      expect(all.map((o) => o.id)).toEqual([cA, cB, userTagged, noSource]);

      // source filter: only the consolidate-sourced ones.
      const consolidated = store.listObservationsBySourceSession(5, { source: 'consolidate' });
      expect(consolidated.map((o) => o.id)).toEqual([cA, cB]);
    });

    it('excludes rows with null/absent metadata and returns [] when nothing matches', () => {
      store.createObservation({ sessionId, kind: 'note', content: 'no metadata' });
      store.createObservation({
        sessionId,
        kind: 'note',
        content: 'metadata without the field',
        metadata: { foo: 'bar' },
      });
      store.createObservation({
        sessionId,
        kind: 'lesson',
        content: 'tagged for 5',
        metadata: { sourceSession: 5 },
        source: 'consolidate',
      });

      expect(store.listObservationsBySourceSession(999)).toEqual([]);
      // the absent-field / null-metadata rows never leak in
      expect(store.listObservationsBySourceSession(5).map((o) => o.kind)).toEqual(['lesson']);
    });

    it('orders results by id ASC and maps rows fully (metadata parsed, source surfaced)', () => {
      const first = store.createObservation({
        sessionId,
        kind: 'lesson',
        content: 'first',
        metadata: { sourceSession: 5, rank: 1 },
        source: 'consolidate',
      });
      const second = store.createObservation({
        sessionId,
        kind: 'lesson',
        content: 'second',
        metadata: { sourceSession: 5, rank: 2 },
        source: 'consolidate',
      });

      const rows = store.listObservationsBySourceSession(5, { source: 'consolidate' });
      expect(rows.map((o) => o.id)).toEqual([first, second]);
      expect(rows[0]?.metadata).toEqual({ sourceSession: 5, rank: 1 });
      expect(rows[0]?.source).toBe('consolidate');
    });
  });
});
