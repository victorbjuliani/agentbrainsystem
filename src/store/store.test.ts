import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_INTERVAL_MS,
  backupIsDue,
  CorruptStoreError,
  MemoryStore,
  SchemaDowngradeError,
  writeValidatedBackup,
} from './memory-store.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './schema.js';

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

    it('refuses to open a DB stamped by a NEWER abs — forward-only guard (#112)', () => {
      // The beforeEach store already migrated to CURRENT; stamp a future version
      // into the ledger to simulate a db written by a newer binary.
      store.close();
      const raw = new Database(dbPath);
      sqliteVec.load(raw);
      raw
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(CURRENT_SCHEMA_VERSION + 1, 'future-migration', new Date().toISOString());
      raw.close();

      const reopened = new MemoryStore({ dbPath, dimensions: DIM });
      let thrown: unknown;
      try {
        reopened.open();
      } catch (e) {
        thrown = e;
      } finally {
        reopened.close();
      }
      expect(thrown).toBeInstanceOf(SchemaDowngradeError);
      expect((thrown as Error).message).toMatch(/newer abs/);
      expect((thrown as SchemaDowngradeError).dbVersion).toBe(CURRENT_SCHEMA_VERSION + 1);
      expect((thrown as SchemaDowngradeError).codeVersion).toBe(CURRENT_SCHEMA_VERSION);
      // The failed open must NOT leak the live connection — open() closes before it
      // throws, so a method that needs the handle now reports it's closed (no WAL/lock
      // left dangling for a fail-open caller).
      expect(() => reopened.schemaVersion()).toThrow(/not open/);
    });

    it('migration v6 — adds the composite (session_id, source) index (#138)', () => {
      expect(CURRENT_SCHEMA_VERSION).toBe(6);
      const raw = new Database(dbPath);
      try {
        const idx = raw
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_observations_session_source'`,
          )
          .get() as { name: string } | undefined;
        expect(idx?.name).toBe('idx_observations_session_source');
      } finally {
        raw.close();
      }
      // Re-open is a no-op (idempotent) — version stays at 6, no error.
      store.close();
      const reopened = new MemoryStore({ dbPath, dimensions: DIM });
      reopened.open();
      expect(reopened.schemaVersion()).toBe(6);
      reopened.close();
    });

    it('records exactly one row per migration — no double-apply (F1-05)', () => {
      // The fresh beforeEach db migrated to CURRENT inside one BEGIN IMMEDIATE txn.
      // The cross-process serialization can't be raced in-process, but the invariant
      // it protects — each version applied at most once — is directly assertable:
      // a double-run (the bug) would either dup a version row or collide on the PK.
      // Re-running migrations on the current db must not add or duplicate any row.
      store.runMigrations();
      const raw = new Database(dbPath);
      try {
        const rows = raw
          .prepare('SELECT version, COUNT(*) AS n FROM schema_migrations GROUP BY version')
          .all() as Array<{ version: number; n: number }>;
        expect(rows.length).toBe(MIGRATIONS.length);
        for (const r of rows) expect(r.n).toBe(1);
      } finally {
        raw.close();
      }
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

    it('filters by project (sessions of that project), composing with order/limit', () => {
      const other = store.createSession({ externalId: 'other', project: 'q' });
      const p1 = store.createObservation({ sessionId, kind: 'user', content: 'p one' });
      const p2 = store.createObservation({ sessionId, kind: 'user', content: 'p two' });
      store.createObservation({ sessionId: other, kind: 'user', content: 'q one' });

      // project 'p' → only this session's observations, none of project 'q'.
      const got = store.listObservations({ project: 'p' }).map((o) => o.id);
      expect(got.sort((a, b) => a - b)).toEqual([p1, p2]);

      // composes with order + limit (newest of project 'p').
      expect(store.listObservations({ project: 'p', order: 'desc', limit: 1 })[0]?.id).toBe(p2);

      // a project with no sessions yields nothing.
      expect(store.listObservations({ project: 'nope' })).toEqual([]);
    });

    it('filters by a set of kinds (kind IN), composing with order/limit (#35)', () => {
      store.createObservation({ sessionId, kind: 'user', content: 'a question' });
      const lessonId = store.createObservation({ sessionId, kind: 'lesson', content: 'a lesson' });
      store.createObservation({ sessionId, kind: 'assistant', content: 'a reply' });
      const decisionId = store.createObservation({
        sessionId,
        kind: 'decision',
        content: 'a decision',
      });

      const kinds = store
        .listObservations({ kinds: ['lesson', 'decision'] })
        .map((o) => o.kind)
        .sort();
      expect(kinds).toEqual(['decision', 'lesson']);

      // order=desc → newest (decision) first; composes with the kinds filter.
      const newestFirst = store
        .listObservations({ kinds: ['lesson', 'decision'], order: 'desc' })
        .map((o) => o.id);
      expect(newestFirst).toEqual([decisionId, lessonId]);

      // Empty array is treated as "no filter" — returns everything.
      expect(store.listObservations({ kinds: [] })).toHaveLength(4);
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

    it('searchFts populates kind; knn leaves it undefined (#141)', () => {
      const a = store.createObservation({ sessionId, kind: 'lesson', content: 'cache eviction' });
      store.indexFts(a, 'cache eviction');
      store.upsertVector(a, unitVector(3));

      const ftsHit = store.searchFts('cache', 5).find((h) => h.id === a);
      expect(ftsHit?.kind).toBe('lesson');

      const knnHit = store.knn(unitVector(3), 1).find((h) => h.id === a);
      expect(knnHit?.kind).toBeUndefined();
    });

    it('searchFts with includeGlobal returns project hits AND global hits, tagged by project', () => {
      const proj = store.createSession({ externalId: 'p1', project: '-Users-me-Devs-foo' });
      const glob = store.createSession({ externalId: '__global__', project: '__global__' });
      const o1 = store.createObservation({
        sessionId: proj,
        kind: 'note',
        content: 'kangaroo project fact',
      });
      const o2 = store.createObservation({
        sessionId: glob,
        kind: 'decision',
        content: 'kangaroo global rule',
      });
      store.indexFts(o1, 'kangaroo project fact');
      store.indexFts(o2, 'kangaroo global rule');

      const scoped = store.searchFts('kangaroo', 10, '-Users-me-Devs-foo');
      expect(scoped.map((h) => h.id)).toEqual([o1]);

      const withGlobal = store.searchFts('kangaroo', 10, '-Users-me-Devs-foo', true);
      expect(withGlobal.map((h) => h.id).sort((a, b) => a - b)).toEqual(
        [o1, o2].sort((a, b) => a - b),
      );
      expect(withGlobal.find((h) => h.id === o2)?.project).toBe('__global__');
    });

    it('moveObservationToSession re-links an observation to another session', () => {
      const a = store.createSession({ externalId: 'a', project: '-Users-me-Devs-foo' });
      const b = store.createSession({ externalId: '__global__', project: '__global__' });
      const id = store.createObservation({
        sessionId: a,
        kind: 'decision',
        content: 'use RAP for S4',
      });
      store.indexFts(id, 'use RAP for S4');

      store.moveObservationToSession(id, b);

      expect(store.getObservation(id)?.sessionId).toBe(b);
      expect(
        store.searchFts('RAP', 10, '-Users-me-Devs-foo', true).find((h) => h.id === id)?.project,
      ).toBe('__global__');
      expect(
        store.searchFts('RAP', 10, '-Users-me-Devs-foo').find((h) => h.id === id),
      ).toBeUndefined();
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

  describe('countUnconsolidatedRawTurns — session-level anti-join (C1)', () => {
    it('counts raw turns of a session with no consolidate row', () => {
      const a = store.createSession({ externalId: 'A', project: 'p' });
      store.createObservation({ sessionId: a, kind: 'user', content: 'a1' });
      store.createObservation({ sessionId: a, kind: 'assistant', content: 'a2' });
      store.createObservation({ sessionId: a, kind: 'user', content: 'a3' });
      expect(store.countUnconsolidatedRawTurns()).toBe(3);
    });

    it('a consolidate row on the session drops its raw count to 0 (whole-session fact)', () => {
      const a = store.createSession({ externalId: 'A', project: 'p' });
      store.createObservation({ sessionId: a, kind: 'user', content: 'a1' });
      store.createObservation({ sessionId: a, kind: 'assistant', content: 'a2' });
      store.createObservation({
        sessionId: a,
        kind: 'lesson',
        content: 'distilled',
        source: 'consolidate',
      });
      expect(store.countUnconsolidatedRawTurns()).toBe(0);
    });

    it('still counts a lower-id session below an already-consolidated one (no stranding)', () => {
      // Session B's raw turns come FIRST (lower ids) and stay unconsolidated.
      const b = store.createSession({ externalId: 'B', project: 'p' });
      store.createObservation({ sessionId: b, kind: 'user', content: 'b1' });
      store.createObservation({ sessionId: b, kind: 'user', content: 'b2' });
      // Session A then gets raw turns AND a consolidate row (higher ids).
      const a = store.createSession({ externalId: 'A', project: 'p' });
      store.createObservation({ sessionId: a, kind: 'user', content: 'a1' });
      store.createObservation({
        sessionId: a,
        kind: 'lesson',
        content: 'd',
        source: 'consolidate',
      });
      // A global high-water cursor would strand B below A's consolidate id; the
      // anti-join counts B's 2 turns correctly.
      expect(store.countUnconsolidatedRawTurns()).toBe(2);
    });

    it('never counts consolidate rows as raw; empty store → 0', () => {
      expect(store.countUnconsolidatedRawTurns()).toBe(0);
      const a = store.createSession({ externalId: 'A', project: 'p' });
      store.createObservation({
        sessionId: a,
        kind: 'lesson',
        content: 'd',
        source: 'consolidate',
      });
      expect(store.countUnconsolidatedRawTurns()).toBe(0);
    });
  });

  describe('countUnconsolidatedSessions — distinct sessions needing consolidate', () => {
    it('counts only sessions with raw turns and no consolidate row', () => {
      const b = store.createSession({ externalId: 'B', project: 'p' });
      store.createObservation({ sessionId: b, kind: 'user', content: 'b1' });
      store.createObservation({ sessionId: b, kind: 'user', content: 'b2' });
      const a = store.createSession({ externalId: 'A', project: 'p' });
      store.createObservation({ sessionId: a, kind: 'user', content: 'a1' });
      store.createObservation({
        sessionId: a,
        kind: 'lesson',
        content: 'd',
        source: 'consolidate',
      });
      // Only B needs consolidate.
      expect(store.countUnconsolidatedSessions()).toBe(1);

      // Consolidate B → 0.
      store.createObservation({
        sessionId: b,
        kind: 'lesson',
        content: 'd2',
        source: 'consolidate',
      });
      expect(store.countUnconsolidatedSessions()).toBe(0);
    });
  });

  describe('countConsolidatedSince — kind + project + cursor filtered (C1/W1)', () => {
    it('filters by kind, project, source=consolidate and the cursor', () => {
      const sp = store.createSession({ externalId: 'sp', project: 'P' });
      const l1 = store.createObservation({
        sessionId: sp,
        kind: 'lesson',
        content: 'l1',
        source: 'consolidate',
      });
      store.createObservation({
        sessionId: sp,
        kind: 'lesson',
        content: 'l2',
        source: 'consolidate',
      });
      store.createObservation({
        sessionId: sp,
        kind: 'decision',
        content: 'd1',
        source: 'consolidate',
      });
      // Interleave raw turns with HIGHER ids — must NOT be counted.
      store.createObservation({ sessionId: sp, kind: 'user', content: 'raw' });

      // Other project Q's consolidate lesson — must NOT count for P.
      const sq = store.createSession({ externalId: 'sq', project: 'Q' });
      store.createObservation({
        sessionId: sq,
        kind: 'lesson',
        content: 'q-lesson',
        source: 'consolidate',
      });

      expect(store.countConsolidatedSince('P', 'lesson', 0)).toBe(2);
      expect(store.countConsolidatedSince('P', 'decision', 0)).toBe(1);
      // Cursor at the max lesson id for P → 0.
      const maxLesson = store.maxConsolidatedId('P', 'lesson');
      expect(store.countConsolidatedSince('P', 'lesson', maxLesson)).toBe(0);
      // Cursor at the first lesson id → only the second lesson remains.
      expect(store.countConsolidatedSince('P', 'lesson', l1)).toBe(1);
    });
  });

  describe('maxConsolidatedId — kind + project filtered', () => {
    it('returns the highest consolidate id for the kind/project, never raw/other-project', () => {
      const sp = store.createSession({ externalId: 'sp', project: 'P' });
      store.createObservation({
        sessionId: sp,
        kind: 'lesson',
        content: 'l1',
        source: 'consolidate',
      });
      const l2 = store.createObservation({
        sessionId: sp,
        kind: 'lesson',
        content: 'l2',
        source: 'consolidate',
      });
      // Higher raw-turn id — must NOT be the max.
      store.createObservation({ sessionId: sp, kind: 'user', content: 'raw' });
      // Other project's higher consolidate lesson — must NOT be the max for P.
      const sq = store.createSession({ externalId: 'sq', project: 'Q' });
      store.createObservation({
        sessionId: sq,
        kind: 'lesson',
        content: 'q',
        source: 'consolidate',
      });

      expect(store.maxConsolidatedId('P', 'lesson')).toBe(l2);
      // No decisions yet → 0.
      expect(store.maxConsolidatedId('P', 'decision')).toBe(0);
    });
  });

  describe('consolidatedIdsSince — kind + project + cursor id list (#138 partition)', () => {
    it('returns the ascending id list above the cursor, filtered to kind/project', () => {
      const sp = store.createSession({ externalId: 'sp', project: 'P' });
      const l1 = store.createObservation({
        sessionId: sp,
        kind: 'lesson',
        content: 'l1',
        source: 'consolidate',
      });
      const l2 = store.createObservation({
        sessionId: sp,
        kind: 'lesson',
        content: 'l2',
        source: 'consolidate',
      });
      store.createObservation({
        sessionId: sp,
        kind: 'decision',
        content: 'd',
        source: 'consolidate',
      });
      store.createObservation({ sessionId: sp, kind: 'user', content: 'raw' });

      expect(store.consolidatedIdsSince('P', 'lesson', 0)).toEqual([l1, l2]);
      expect(store.consolidatedIdsSince('P', 'lesson', l1)).toEqual([l2]);
      expect(store.consolidatedIdsSince('P', 'lesson', l2)).toEqual([]);
    });
  });

  describe('countObservationsBySession (W2)', () => {
    it('counts all observations of a session; unknown id → 0', () => {
      const a = store.createSession({ externalId: 'A', project: 'p' });
      store.createObservation({ sessionId: a, kind: 'user', content: '1' });
      store.createObservation({ sessionId: a, kind: 'assistant', content: '2' });
      store.createObservation({ sessionId: a, kind: 'user', content: '3' });
      store.createObservation({
        sessionId: a,
        kind: 'lesson',
        content: '4',
        source: 'consolidate',
      });
      expect(store.countObservationsBySession(a)).toBe(4);
      expect(store.countObservationsBySession(999999)).toBe(0);
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

  describe('setSessionProject (#50)', () => {
    it('creates a session when none exists for the externalId', () => {
      const id = store.setSessionProject('sess-new', 'MyProject');
      expect(id).toBeGreaterThan(0);
      const s = store.getSessionByExternalId('sess-new');
      expect(s?.id).toBe(id);
      expect(s?.project).toBe('MyProject');
    });

    it('UPDATEs the project of an existing row, keeping the same id (Risk #2 override)', () => {
      const created = store.createSession({ externalId: 'sess-auto', project: 'auto-slug' });
      const updated = store.setSessionProject('sess-auto', 'Intentional');
      expect(updated).toBe(created);
      expect(store.getSessionByExternalId('sess-auto')?.project).toBe('Intentional');
      expect(store.counts().sessions).toBe(1); // updated, not duplicated
    });
  });

  describe('listProjects (#51)', () => {
    it('returns distinct non-NULL projects, sorted', () => {
      store.createSession({ externalId: 's1', project: 'Beta' });
      store.createSession({ externalId: 's2', project: 'Alpha' });
      store.createSession({ externalId: 's3', project: 'Beta' }); // dup
      store.createSession({ externalId: 's4' }); // NULL project — excluded
      expect(store.listProjects()).toEqual(['Alpha', 'Beta']);
    });

    it('includes the literal string "null" (a real label, distinct from SQL NULL)', () => {
      store.createSession({ externalId: 's1', project: 'null' });
      store.createSession({ externalId: 's2' }); // SQL NULL
      expect(store.listProjects()).toEqual(['null']);
    });

    it('returns an empty array when no sessions have a project', () => {
      store.createSession({ externalId: 's1' });
      expect(store.listProjects()).toEqual([]);
    });
  });

  describe('deleteMeta / listMetaKeys (#50)', () => {
    it('deleteMeta removes a key and is a no-op when absent', () => {
      store.setMeta('k1', 'v1');
      store.deleteMeta('k1');
      expect(store.getMeta('k1')).toBeNull();
      expect(() => store.deleteMeta('missing')).not.toThrow();
    });

    it('listMetaKeys returns only keys under a literal prefix, ascending', () => {
      store.setMeta('session-project:b', 'x');
      store.setMeta('session-project:a', 'x');
      store.setMeta('ingest:cursor:/f', '1');
      store.setMeta('session-projectZZ', 'x'); // outside the ':'-suffixed range — must be excluded
      expect(store.listMetaKeys('session-project:')).toEqual([
        'session-project:a',
        'session-project:b',
      ]);
    });

    it('listMetaKeys with an empty prefix returns all keys', () => {
      store.setMeta('a', '1');
      store.setMeta('b', '2');
      expect(store.listMetaKeys('')).toEqual(['a', 'b']);
    });
  });

  describe('incrMeta — atomic counter UPSERT (#138 RC-004)', () => {
    it('creates the key at delta when absent and returns the new value', () => {
      expect(store.incrMeta('autoDistill:runs', 1)).toBe(1);
      expect(store.getMeta('autoDistill:runs')).toBe('1');
    });

    it('accumulates across calls (the lost-update-proof path)', () => {
      store.incrMeta('autoDistill:tokens', 100);
      store.incrMeta('autoDistill:tokens', 250);
      expect(store.incrMeta('autoDistill:tokens', 0)).toBe(350);
    });

    it('treats a non-integer stored value as 0 before adding (defensive CAST)', () => {
      store.setMeta('counter', 'garbage');
      expect(store.incrMeta('counter', 5)).toBe(5);
    });

    it('does not disturb an unrelated key', () => {
      store.setMeta('other', 'keep');
      store.incrMeta('counter', 1);
      expect(store.getMeta('other')).toBe('keep');
    });
  });

  describe('project-scoped recall queries (#47)', () => {
    /** Seed two projects sharing identical content; return their observation ids. */
    function seedTwoProjects(): { a: number; b: number } {
      const sa = store.createSession({ externalId: 'sa', project: 'ProjA' });
      const sb = store.createSession({ externalId: 'sb', project: 'ProjB' });
      const sn = store.createSession({ externalId: 'sn' }); // NULL project
      const a = store.createObservation({
        sessionId: sa,
        kind: 'user',
        content: 'kubernetes ingress nginx',
      });
      const b = store.createObservation({
        sessionId: sb,
        kind: 'user',
        content: 'kubernetes ingress nginx',
      });
      const n = store.createObservation({
        sessionId: sn,
        kind: 'user',
        content: 'kubernetes ingress nginx',
      });
      for (const id of [a, b, n]) {
        store.indexFts(id, 'kubernetes ingress nginx');
        store.upsertVector(id, unitVector(id));
      }
      return { a, b };
    }

    it('searchFts with a project returns only that project (no leak); no project → all', () => {
      const { a, b } = seedTwoProjects();
      const scoped = store.searchFts('"kubernetes"', 10, 'ProjA').map((h) => h.id);
      expect(scoped).toEqual([a]);
      const wide = store
        .searchFts('"kubernetes"', 10)
        .map((h) => h.id)
        .sort((x, y) => x - y);
      expect(wide).toContain(a);
      expect(wide).toContain(b);
      expect(wide.length).toBe(3); // ProjA + ProjB + NULL-project
    });

    it('searchFts scoped excludes NULL-project observations', () => {
      seedTwoProjects();
      const scoped = store.searchFts('"kubernetes"', 10, 'ProjB');
      // exactly ProjB's row — never the NULL-project one
      expect(scoped.length).toBe(1);
    });

    it('knn with a project returns only that project (no leak)', () => {
      const { a } = seedTwoProjects();
      const scoped = store.knn(unitVector(a), 10, 'ProjA').map((h) => h.id);
      expect(scoped).toEqual([a]);
      const wide = store.knn(unitVector(a), 10).map((h) => h.id);
      expect(wide.length).toBe(3);
    });

    it('a project with no observations returns nothing (strict isolation, no fallback)', () => {
      seedTwoProjects();
      expect(store.searchFts('"kubernetes"', 10, 'Nonexistent')).toEqual([]);
      expect(store.knn(unitVector(1), 10, 'Nonexistent')).toEqual([]);
    });
  });
});

describe('MemoryStore — corruption resilience (#101)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-resilience-'));
    dbPath = join(dir, 'memory.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('backupIsDue (pure gate)', () => {
    it('is due when no backup exists', () => {
      expect(backupIsDue(null, Date.now())).toBe(true);
    });
    it('is not due within the interval, due after it', () => {
      const now = Date.now();
      expect(backupIsDue(now - 1000, now)).toBe(false);
      expect(backupIsDue(now - BACKUP_INTERVAL_MS, now)).toBe(true);
    });
  });

  it('quickCheck reports ok on a healthy store', () => {
    const store = new MemoryStore({ dbPath, dimensions: DIM }).open();
    expect(store.quickCheck()).toEqual({ ok: true, errors: [] });
    store.close();
  });

  it('throws a CorruptStoreError (not a raw throw) when opening a non-db file', () => {
    writeFileSync(dbPath, 'this is definitely not a sqlite database');
    const store = new MemoryStore({ dbPath, dimensions: DIM });
    expect(() => store.open()).toThrow(CorruptStoreError);
    try {
      store.open();
    } catch (e) {
      expect((e as Error).message).toMatch(/appears corrupt/);
      expect((e as Error).message).toMatch(/abs doctor/);
    }
  });

  it('creates a .bak on first open of a pre-existing db, and not again within the window', () => {
    // First, create + populate a real db, then close it so it pre-exists on reopen.
    const seed = new MemoryStore({ dbPath, dimensions: DIM }).open();
    seed.createSession({ externalId: 's1' });
    seed.close();

    const bak = `${dbPath}.bak`;
    const first = new MemoryStore({ dbPath, dimensions: DIM }).open();
    const firstMtime = statSync(bak).mtimeMs;
    first.close();

    // Reopen within the window → backup must NOT be rewritten.
    const second = new MemoryStore({ dbPath, dimensions: DIM }).open();
    expect(statSync(bak).mtimeMs).toBe(firstMtime);
    second.close();

    // Age the backup past the interval → next open refreshes it.
    const old = (Date.now() - BACKUP_INTERVAL_MS - 1000) / 1000;
    utimesSync(bak, old, old);
    const third = new MemoryStore({ dbPath, dimensions: DIM }).open();
    expect(statSync(bak).mtimeMs).toBeGreaterThan(firstMtime);
    third.close();
  });

  it('does not back up a brand-new db (nothing to protect yet)', () => {
    const store = new MemoryStore({ dbPath, dimensions: DIM }).open();
    store.close();
    expect(() => statSync(`${dbPath}.bak`)).toThrow();
  });

  it('walSizeBytes is a non-negative number on a real store, 0 for in-memory', () => {
    const store = new MemoryStore({ dbPath, dimensions: DIM }).open();
    store.createSession({ externalId: 's1' });
    expect(store.walSizeBytes()).toBeGreaterThanOrEqual(0);
    store.close();
    const mem = new MemoryStore({ dbPath: ':memory:', dimensions: DIM }).open();
    expect(mem.walSizeBytes()).toBe(0);
    mem.close();
  });

  it('a backup copy reopens as a healthy store (recovery path works)', () => {
    const seed = new MemoryStore({ dbPath, dimensions: DIM }).open();
    seed.createSession({ externalId: 's1' });
    seed.close();
    // Reopen to mint the .bak, then simulate restoring it.
    new MemoryStore({ dbPath, dimensions: DIM }).open().close();
    const restored = join(dir, 'restored.db');
    copyFileSync(`${dbPath}.bak`, restored);
    const store = new MemoryStore({ dbPath: restored, dimensions: DIM }).open();
    expect(store.quickCheck().ok).toBe(true);
    expect(store.listSessions().length).toBe(1);
    store.close();
  });
});

describe('writeValidatedBackup — atomic, validated backup (F1-04)', () => {
  let dir: string;
  let src: string;
  let bak: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-bak-'));
    src = join(dir, 'memory.db');
    bak = `${src}.bak`;
    // A real, integrity-clean source db to copy.
    new MemoryStore({ dbPath: src, dimensions: DIM }).open().close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies a valid db, promotes it atomically, leaves no temp behind', () => {
    expect(writeValidatedBackup(src, bak)).toBe(true);
    expect(existsSync(bak)).toBe(true);
    // The promoted backup is a structurally-sound db (recovery path works).
    const restored = new MemoryStore({ dbPath: bak, dimensions: DIM }).open();
    expect(restored.quickCheck().ok).toBe(true);
    restored.close();
    // No `.tmp-*` scratch file survives.
    expect(readdirSync(dir).some((f) => f.includes('.bak.tmp-'))).toBe(false);
  });

  it('does NOT overwrite a good .bak when the copy fails validation (torn-bak guard)', () => {
    // Mint a known-good backup first, capture its bytes.
    expect(writeValidatedBackup(src, bak)).toBe(true);
    const goodBytes = statSync(bak).size;
    // Now point the source at a garbage "db": the copy validates as corrupt, so the
    // previous good .bak must survive untouched and no temp may linger.
    const garbage = join(dir, 'garbage.db');
    writeFileSync(garbage, 'this is not a sqlite database');
    expect(writeValidatedBackup(garbage, bak)).toBe(false);
    expect(existsSync(bak)).toBe(true);
    expect(statSync(bak).size).toBe(goodBytes); // unchanged — good backup preserved
    expect(readdirSync(dir).some((f) => f.includes('.bak.tmp-'))).toBe(false);
  });
});

describe('MemoryStore — content-hash idempotence (#105)', () => {
  let dir: string;
  let store: MemoryStore;
  let sessionId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-idem-'));
    store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: DIM }).open();
    sessionId = store.createSession({ externalId: 's1' });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a re-ingest of identical (session, content, source) is one row, same id', () => {
    const a = store.createObservation({ sessionId, kind: 'note', content: 'dup', source: 'f' });
    const b = store.createObservation({ sessionId, kind: 'note', content: 'dup', source: 'f' });
    expect(b).toBe(a);
    expect(store.counts().observations).toBe(1);
  });

  it('distinct content, session, or source produce separate rows', () => {
    const base = store.createObservation({ sessionId, kind: 'note', content: 'x', source: 'f' });
    const diffContent = store.createObservation({
      sessionId,
      kind: 'note',
      content: 'y',
      source: 'f',
    });
    const diffSource = store.createObservation({
      sessionId,
      kind: 'note',
      content: 'x',
      source: 'g',
    });
    const other = store.createSession({ externalId: 's2' });
    const diffSession = store.createObservation({
      sessionId: other,
      kind: 'note',
      content: 'x',
      source: 'f',
    });
    expect(new Set([base, diffContent, diffSource, diffSession]).size).toBe(4);
    expect(store.counts().observations).toBe(4);
    // present-vs-absent source is also distinct
    const noSource = store.createObservation({ sessionId, kind: 'note', content: 'x' });
    expect(noSource).not.toBe(base);
  });

  it('the v5 migration backfills + dedupes a populated v4 store and adds the unique index', () => {
    // Build a pre-v5 store (schema through v4, no content_hash), insert duplicates
    // the way the old at-least-once path could, then run the v5 migration alone.
    const db = new Database(':memory:');
    sqliteVec.load(db);
    for (const m of MIGRATIONS) if (m.version <= 4) m.up(db, DIM);
    db.exec("INSERT INTO sessions (external_id, created_at) VALUES ('s', '2026-01-01')");
    const ins = db.prepare(
      "INSERT INTO observations (session_id, kind, content, source, created_at) VALUES (1,'note',?,?, '2026-01-01')",
    );
    ins.run('dup', 'src'); // id 1
    ins.run('dup', 'src'); // id 2 — duplicate of 1
    ins.run('dup', 'src'); // id 3 — duplicate of 1
    ins.run('unique', 'src'); // id 4
    expect((db.prepare('SELECT COUNT(*) c FROM observations').get() as { c: number }).c).toBe(4);

    const v5 = MIGRATIONS.find((m) => m.version === 5);
    expect(v5).toBeDefined();
    v5?.up(db, DIM);

    // Dedupe kept the lowest id per hash: one 'dup' (id 1) + 'unique' (id 4).
    const ids = (
      db.prepare('SELECT id FROM observations ORDER BY id').all() as Array<{
        id: number;
      }>
    ).map((r) => r.id);
    expect(ids).toEqual([1, 4]);
    // content_hash backfilled, unique index enforced.
    const dupHash = (
      db.prepare('SELECT content_hash h FROM observations WHERE id = 1').get() as { h: string }
    ).h;
    expect(dupHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO observations (session_id, kind, content, source, created_at, content_hash) VALUES (1,'note','dup','src','2026-01-01', ?)",
        )
        .run(dupHash),
    ).toThrow(/UNIQUE/i);
    db.close();
  });
});
