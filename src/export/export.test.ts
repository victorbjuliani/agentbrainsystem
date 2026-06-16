import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../store/memory-store.js';
import { exportStore, importStore } from './index.js';

const DIM = 8;

/** A deterministic unit vector of length DIM with a single hot dimension. */
function unitVector(hot: number, dim = DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  v[hot % dim] = 1;
  return v;
}

/** Seed a store with two sessions, observations, vectors and fts entries. */
function seed(store: MemoryStore): void {
  const s1 = store.createSession({
    externalId: 'sess-alpha',
    project: 'agentbrainsystem',
    meta: { harness: 'claude-code' },
  });
  const s2 = store.createSession({ externalId: 'sess-beta', project: 'p2' });

  const a = store.createObservation({
    sessionId: s1,
    kind: 'decision',
    content: 'use sqlite-vec for the vector index',
    metadata: { confidence: 0.9 },
    source: 'test',
  });
  const b = store.createObservation({
    sessionId: s1,
    kind: 'user',
    content: 'the cat sat on the mat',
  });
  const c = store.createObservation({
    sessionId: s2,
    kind: 'lesson',
    content: 'streaming export keeps memory low',
  });

  store.upsertVector(a, unitVector(0));
  store.upsertVector(b, unitVector(3));
  store.upsertVector(c, unitVector(5));

  store.indexFts(a, 'use sqlite-vec for the vector index');
  store.indexFts(b, 'the cat sat on the mat');
  store.indexFts(c, 'streaming export keeps memory low');
}

/** Resolve the content of the single best knn hit for a query vector. */
function topKnnContent(store: MemoryStore, query: number[]): string | undefined {
  const hits = store.knn(query, 1);
  const id = hits[0]?.id;
  return id !== undefined ? (store.getObservation(id)?.content ?? undefined) : undefined;
}

/** Resolve the contents matching an fts term, sorted for stable comparison. */
function ftsContents(store: MemoryStore, term: string): string[] {
  return store
    .searchFts(term, 50)
    .map((h) => store.getObservation(h.id)?.content)
    .filter((c): c is string => typeof c === 'string')
    .sort();
}

describe('export / import round-trip', () => {
  let dir: string;
  let outPath: string;
  let source: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-export-'));
    outPath = join(dir, 'artifact.jsonl');
    source = new MemoryStore({ dbPath: join(dir, 'source.db'), dimensions: DIM });
    source.open();
    seed(source);
  });

  afterEach(() => {
    source.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('exportStore', () => {
    it('returns counts and writes a versioned JSONL header + one line per row', () => {
      const result = exportStore(source, outPath);
      return result.then((res) => {
        expect(res).toEqual({ sessions: 2, observations: 3 });

        const lines = readFileSync(outPath, 'utf8').trim().split('\n');
        // 1 header + 2 sessions + 3 observations
        expect(lines).toHaveLength(6);

        const header = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
        expect(header.format).toBe('abs-export');
        expect(header.version).toBe(1);
        expect(header.embedding).toMatchObject({ dimensions: DIM });
        expect(header.counts).toMatchObject({ sessions: 2, observations: 3 });
        expect(typeof header.createdAt).toBe('string');

        const types = lines.slice(1).map((l) => (JSON.parse(l) as { t: string }).t);
        expect(types.filter((t) => t === 'session')).toHaveLength(2);
        expect(types.filter((t) => t === 'obs')).toHaveLength(3);
      });
    });

    it('includes the stored vector with each observation line', async () => {
      await exportStore(source, outPath);
      const lines = readFileSync(outPath, 'utf8').trim().split('\n');
      const obsLines = lines
        .slice(1)
        .map((l) => JSON.parse(l) as { t: string; content: string; vector: number[] | null })
        .filter((o) => o.t === 'obs');
      const decision = obsLines.find((o) => o.content.includes('sqlite-vec'));
      expect(decision?.vector).toEqual(unitVector(0));
    });
  });

  describe('importStore — replace into a fresh store', () => {
    it('reproduces counts, knn and fts identically', async () => {
      const before = source.counts();
      await exportStore(source, outPath);

      const target = new MemoryStore({ dbPath: join(dir, 'target.db'), dimensions: DIM });
      target.open();
      const res = await importStore(target, outPath, { mode: 'replace' });
      expect(res).toEqual({ sessionsImported: 2, observationsImported: 3 });

      expect(target.counts()).toEqual(before);
      expect(topKnnContent(target, unitVector(0))).toBe('use sqlite-vec for the vector index');
      expect(topKnnContent(target, unitVector(5))).toBe('streaming export keeps memory low');
      expect(ftsContents(target, 'cat')).toEqual(['the cat sat on the mat']);
      expect(ftsContents(target, 'streaming')).toEqual(['streaming export keeps memory low']);
      target.close();
    });

    it('replace wipes pre-existing data first', async () => {
      await exportStore(source, outPath);

      const target = new MemoryStore({ dbPath: join(dir, 'target.db'), dimensions: DIM });
      target.open();
      // pre-existing junk that must be gone after a replace import
      const junkSession = target.createSession({ externalId: 'junk' });
      const junkObs = target.createObservation({
        sessionId: junkSession,
        kind: 'user',
        content: 'should be wiped',
      });
      target.indexFts(junkObs, 'should be wiped');

      await importStore(target, outPath, { mode: 'replace' });
      expect(target.getSessionByExternalId('junk')).toBeNull();
      expect(ftsContents(target, 'wiped')).toEqual([]);
      expect(target.counts()).toEqual(source.counts());
      target.close();
    });
  });

  describe('importStore — merge', () => {
    it('keeps existing data and appends imported rows, reusing sessions by externalId', async () => {
      await exportStore(source, outPath);

      const target = new MemoryStore({ dbPath: join(dir, 'target.db'), dimensions: DIM });
      target.open();
      // pre-existing data, including a session sharing an externalId with the artifact
      const existing = target.createSession({ externalId: 'sess-alpha', project: 'pre' });
      const keep = target.createObservation({
        sessionId: existing,
        kind: 'note',
        content: 'pre-existing keeper',
      });
      target.upsertVector(keep, unitVector(7));
      target.indexFts(keep, 'pre-existing keeper');

      const res = await importStore(target, outPath, { mode: 'merge' });
      expect(res).toEqual({ sessionsImported: 2, observationsImported: 3 });

      // sess-alpha reused (not duplicated): 1 existing + sess-beta created = 2 total
      expect(target.listSessions()).toHaveLength(2);
      // 1 pre-existing + 3 imported observations
      expect(target.counts().observations).toBe(4);

      // both pre-existing and imported recall correctly
      expect(topKnnContent(target, unitVector(7))).toBe('pre-existing keeper');
      expect(topKnnContent(target, unitVector(0))).toBe('use sqlite-vec for the vector index');
      expect(ftsContents(target, 'cat')).toEqual(['the cat sat on the mat']);
      expect(ftsContents(target, 'keeper')).toEqual(['pre-existing keeper']);
      target.close();
    });

    it('merge into an empty store equals a replace into an empty store', async () => {
      await exportStore(source, outPath);
      const target = new MemoryStore({ dbPath: join(dir, 'target.db'), dimensions: DIM });
      target.open();
      await importStore(target, outPath, { mode: 'merge' });
      expect(target.counts()).toEqual(source.counts());
      target.close();
    });
  });

  describe('header validation', () => {
    it('rejects an artifact whose dimensions differ from the target store', async () => {
      await exportStore(source, outPath); // dimensions: 8

      const target = new MemoryStore({ dbPath: join(dir, 'target.db'), dimensions: 16 });
      target.open();
      await expect(importStore(target, outPath, { mode: 'replace' })).rejects.toThrow(/dimension/i);
      target.close();
    });

    it('rejects a bad/missing header (wrong format)', async () => {
      const bad = join(dir, 'bad.jsonl');
      writeArtifact(bad, ['{"format":"not-abs","version":1}']);
      const target = new MemoryStore({ dbPath: join(dir, 'target.db'), dimensions: DIM });
      target.open();
      await expect(importStore(target, bad, { mode: 'replace' })).rejects.toThrow(/format/i);
      target.close();
    });

    it('rejects an unsupported version', async () => {
      const bad = join(dir, 'badver.jsonl');
      writeArtifact(bad, [
        JSON.stringify({
          format: 'abs-export',
          version: 999,
          embedding: { provider: 'local', model: 'm', dimensions: DIM },
        }),
      ]);
      const target = new MemoryStore({ dbPath: join(dir, 'target.db'), dimensions: DIM });
      target.open();
      await expect(importStore(target, bad, { mode: 'replace' })).rejects.toThrow(/version/i);
      target.close();
    });

    it('rejects an empty artifact', async () => {
      const empty = join(dir, 'empty.jsonl');
      writeArtifact(empty, []);
      const target = new MemoryStore({ dbPath: join(dir, 'target.db'), dimensions: DIM });
      target.open();
      await expect(importStore(target, empty, { mode: 'replace' })).rejects.toThrow();
      target.close();
    });
  });

  describe('integrity — issue #157', () => {
    // F3-03: a mid-write crash must not leave outPath truncated/empty. We force a
    // write failure after the header line, then assert the destination is untouched.
    it('F3-03: a failed export leaves outPath absent (atomic via temp + rename)', async () => {
      const existing = join(dir, 'preexisting.jsonl');
      writeArtifact(existing, ['original-content']);

      // A store whose iterateObservations throws partway proves the destination
      // is only published on full success — a partial write must not surface.
      const boom = new MemoryStore({ dbPath: join(dir, 'boom.db'), dimensions: DIM });
      boom.open();
      boom.createSession({ externalId: 'boom-sess' });
      boom.iterateObservations = (() => {
        throw new Error('simulated mid-export failure');
      }) as typeof boom.iterateObservations;

      await expect(exportStore(boom, existing)).rejects.toThrow(/simulated mid-export/);

      // The pre-existing file must be untouched — no truncation, no partial header.
      expect(readFileSync(existing, 'utf8')).toBe('original-content\n');
      // And no leftover temp artifact.
      expect(existsSync(`${existing}.tmp`)).toBe(false);
      boom.close();
    });

    // F3-01: a mid-import error under `replace` must NOT leave the store wiped.
    // We corrupt a data line so the import throws after the header (which is where
    // the old code wiped) and assert pre-existing data survives.
    it('F3-01: a failed replace import leaves the store at its pre-import state', async () => {
      await exportStore(source, outPath);
      // Append a corrupt observation line so the import throws mid-stream.
      const good = readFileSync(outPath, 'utf8');
      const corrupt = join(dir, 'corrupt.jsonl');
      writeFileSync(corrupt, `${good}not-valid-json\n`, 'utf8');

      const target = new MemoryStore({ dbPath: join(dir, 'target.db'), dimensions: DIM });
      target.open();
      const keepSession = target.createSession({ externalId: 'keeper-sess', project: 'pre' });
      const keepObs = target.createObservation({
        sessionId: keepSession,
        kind: 'note',
        content: 'must survive a failed replace',
      });
      target.indexFts(keepObs, 'must survive a failed replace');
      const before = target.counts();

      await expect(importStore(target, corrupt, { mode: 'replace' })).rejects.toThrow();

      // The store must be exactly as it was before the failed import — NOT wiped.
      expect(target.counts()).toEqual(before);
      expect(target.getSessionByExternalId('keeper-sess')).not.toBeNull();
      expect(ftsContents(target, 'survive')).toEqual(['must survive a failed replace']);
      target.close();
    });

    // F3-02: a truncated artifact (header declares more rows than are present)
    // must be rejected, not silently imported as a partial success.
    it('F3-02: import rejects a truncated artifact (header count > rows present)', async () => {
      await exportStore(source, outPath);
      const lines = readFileSync(outPath, 'utf8').trim().split('\n');
      // Drop the last observation line — header still declares 3 observations.
      const truncated = join(dir, 'truncated.jsonl');
      writeFileSync(truncated, `${lines.slice(0, -1).join('\n')}\n`, 'utf8');

      const target = new MemoryStore({ dbPath: join(dir, 'target.db'), dimensions: DIM });
      target.open();
      await expect(importStore(target, truncated, { mode: 'replace' })).rejects.toThrow(
        /truncated|mismatch|count/i,
      );
      target.close();
    });

    // F3-02 (export side): if observed rows disagree with the header counts taken
    // pre-iteration, export must throw rather than finalize a lying artifact.
    it('F3-02: export throws when observed rows disagree with header counts', async () => {
      const drift = new MemoryStore({ dbPath: join(dir, 'drift.db'), dimensions: DIM });
      drift.open();
      const s = drift.createSession({ externalId: 'drift-sess' });
      drift.createObservation({ sessionId: s, kind: 'note', content: 'one' });
      drift.createObservation({ sessionId: s, kind: 'note', content: 'two' });

      // counts() reports 2 observations, but iterateObservations yields only 1 →
      // a real-world truncation/inconsistency the finalize assertion must catch.
      const original = drift.iterateObservations.bind(drift);
      drift.iterateObservations = function* (...args: Parameters<typeof original>) {
        let n = 0;
        for (const o of original(...args)) {
          if (n++ >= 1) break;
          yield o;
        }
      } as typeof drift.iterateObservations;

      const driftOut = join(dir, 'drift.jsonl');
      await expect(exportStore(drift, driftOut)).rejects.toThrow(/mismatch|count|truncat/i);
      drift.close();
    });

    // F3-02 (PR #165): a dangling observation (orphan row a corrupt store could hold;
    // FK CASCADE normally prevents one) is skipped, and the header must declare only the
    // WRITTEN rows — otherwise it over-declares and THIS build's importer rejects the
    // artifact as truncated, i.e. an export this build cannot reimport.
    it('F3-02: a dangling observation is skipped; header matches written rows (reimportable)', async () => {
      // Inject an orphan by bypassing the FK CASCADE on a raw connection.
      const Database = (await import('better-sqlite3')).default;
      const raw = new Database(join(dir, 'source.db'));
      raw.pragma('foreign_keys = OFF');
      raw
        .prepare(
          'INSERT INTO observations (session_id, kind, content, created_at) VALUES (?,?,?,?)',
        )
        .run(99999, 'note', 'orphan with no session', new Date().toISOString());
      raw.close();

      // Source now holds 3 valid + 1 orphan; only the 3 valid rows are writable.
      const res = await exportStore(source, outPath);
      expect(res.observations).toBe(3); // orphan skipped, not written

      const header = JSON.parse(readFileSync(outPath, 'utf8').split('\n')[0] ?? '') as {
        counts: { observations: number };
      };
      expect(header.counts.observations).toBe(3); // matches written rows, not the raw total

      // The artifact reimports cleanly — before the fix the header declared 4 and import
      // rejected it as truncated (3 lines < 4 declared).
      const target = new MemoryStore({ dbPath: join(dir, 'target.db'), dimensions: DIM });
      target.open();
      const imp = await importStore(target, outPath, { mode: 'replace' });
      expect(imp.observationsImported).toBe(3);
      target.close();
    });

    // F3-04: a `replace` is a FULL reset — ingest cursors and degraded/rebuild
    // flags must be cleared, so the next ingest does not resume from stale state.
    // `session-project:*` bindings (explicit user decisions) must be PRESERVED.
    it('F3-04: replace clears ingest state meta but preserves session-project bindings', async () => {
      await exportStore(source, outPath);

      const target = new MemoryStore({ dbPath: join(dir, 'target.db'), dimensions: DIM });
      target.open();
      // Stale ingest state that a "full reset" must not leave behind.
      target.setMeta('ingest:cursor:/some/transcript.jsonl', '4096');
      target.setMeta('codex:cwd:/some/rollout.jsonl', '/repo');
      target.setMeta('ingest:copilot-cwd:/some/copilot.json', '/repo');
      target.setMeta('gemini:lastid:/some/gemini.json', 'msg-42');
      target.setMeta('opencode:cursor:ses_abc123', 'prt_999'); // PR #165: must also clear
      target.setMeta('index:rebuild_failed_at', '2026-01-01T00:00:00Z');
      target.setMeta('ingest:deferred_at', '2026-01-01T00:00:00Z');
      target.setMeta('embed:model_load_timeout_at', '2026-01-01T00:00:00Z');
      // Explicit user project binding — must SURVIVE the reset.
      target.setMeta('session-project:codex:keepme', '{"project":"chosen"}');

      await importStore(target, outPath, { mode: 'replace' });

      // Ingest state cleared.
      expect(target.getMeta('ingest:cursor:/some/transcript.jsonl')).toBeNull();
      expect(target.getMeta('codex:cwd:/some/rollout.jsonl')).toBeNull();
      expect(target.getMeta('ingest:copilot-cwd:/some/copilot.json')).toBeNull();
      expect(target.getMeta('gemini:lastid:/some/gemini.json')).toBeNull();
      expect(target.getMeta('opencode:cursor:ses_abc123')).toBeNull(); // PR #165
      expect(target.getMeta('index:rebuild_failed_at')).toBeNull();
      expect(target.getMeta('ingest:deferred_at')).toBeNull();
      expect(target.getMeta('embed:model_load_timeout_at')).toBeNull();
      // Project binding preserved.
      expect(target.getMeta('session-project:codex:keepme')).toBe('{"project":"chosen"}');
      target.close();
    });
  });
});

/** Write a raw artifact (header + data lines) for the validation tests. */
function writeArtifact(path: string, lines: string[]): void {
  writeFileSync(path, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}
