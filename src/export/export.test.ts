import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
});

/** Write a raw artifact (header + data lines) for the validation tests. */
function writeArtifact(path: string, lines: string[]): void {
  writeFileSync(path, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}
