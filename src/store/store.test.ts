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

    it('iterates observations without materializing the whole set', () => {
      for (let i = 0; i < 3; i++) {
        store.createObservation({ sessionId, kind: 'user', content: `m${i}` });
      }
      const seen: string[] = [];
      for (const obs of store.iterateObservations()) seen.push(obs.content);
      expect(seen).toHaveLength(3);
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
});
