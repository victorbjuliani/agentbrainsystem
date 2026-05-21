/**
 * Delete core tests (Phase A).
 *
 * Covers: preview/execute happy path per selector; byIds dedupe + notFound;
 * bySearch uses recallFts and does NO embedding (a provider whose `embed` throws
 * proves it); handle pinning (TOCTOU — execute deletes exactly the previewed set
 * even if rows were added between preview and execute); replayed/expired handle →
 * unknown-handle; the C1 no-cursor-clamp staleness correctness; and index-orphan
 * consistency after execute.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '../embedding/index.js';
import { OPTIMIZE_CURSOR_KEY } from '../hooks/staleness.js';
import { Indexer } from '../indexer/index.js';
import type { Memory } from '../memory.js';
import { Recall } from '../recall/index.js';
import { MemoryStore } from '../store/index.js';
import {
  __clearDeleteCacheForTests,
  execute,
  executeIds,
  preview,
  previewSelector,
} from './delete.js';
import { DeleteRefusalError } from './types.js';

const DIM = 8;

/** Deterministic offline embedding (used for seeding via the indexer). */
class FakeEmbedding implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-v1';
  readonly dimensions = DIM;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(DIM).fill(0);
      for (let i = 0; i < t.length; i++) v[i % DIM] = (v[i % DIM] ?? 0) + 1;
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

/** A provider that EXPLODES if `embed` is ever called — proves bySearch is FTS-only. */
class ThrowingEmbedding implements EmbeddingProvider {
  readonly id = 'throwing';
  readonly model = 'throwing-v1';
  readonly dimensions = DIM;
  async embed(): Promise<number[][]> {
    throw new Error('embed() must not be called by the delete path');
  }
}

let dir: string;

function newMemory(provider: EmbeddingProvider = new FakeEmbedding()): Memory {
  const store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: DIM }).open();
  return {
    store,
    provider,
    indexer: new Indexer(store, provider),
    recall: new Recall(store, provider),
    close: () => store.close(),
  };
}

/** Seed an indexed observation (vec + fts) through the indexer; return its id. */
async function seedObs(
  memory: Memory,
  sessionId: number,
  content: string,
  kind = 'user',
): Promise<number> {
  return memory.indexer.write({ sessionId, kind, content });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-delete-'));
  __clearDeleteCacheForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('preview/execute — happy path per selector', () => {
  it('byIds: previews the named observations and deletes exactly them', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    const a = await seedObs(memory, s, 'alpha');
    const b = await seedObs(memory, s, 'beta');
    await seedObs(memory, s, 'gamma'); // survivor

    const p = preview(memory, { byIds: [a, b] });
    expect(p.count).toBe(2);
    expect(p.items.map((i) => i.id)).toEqual([a, b]);
    expect(p.notFound).toEqual([]);

    const res = execute(memory, p.handle);
    expect(res.deleted).toEqual([a, b]);
    expect(res.notFound).toEqual([]);
    expect(memory.store.counts()).toMatchObject({ observations: 1, vectors: 1, fts: 1 });
    memory.close();
  });

  it('bySession: deletes every observation of the session', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    const other = memory.store.createSession({ externalId: 's2' });
    await seedObs(memory, s, 'one');
    await seedObs(memory, s, 'two');
    await seedObs(memory, other, 'survivor');

    const p = preview(memory, { bySession: s });
    expect(p.count).toBe(2);
    const res = execute(memory, p.handle);
    expect(res.deleted.length).toBe(2);
    // bySession also drops the now-empty session row (no orphan hub); the other
    // session + its obs survive.
    expect(memory.store.counts()).toMatchObject({
      sessions: 1,
      observations: 1,
      vectors: 1,
      fts: 1,
    });
    expect(memory.store.getSession(s)).toBeNull();
    expect(memory.store.getSession(other)).not.toBeNull();
    memory.close();
  });

  it('byProject: deletes observations across all sessions of the project', async () => {
    const memory = newMemory();
    const s1 = memory.store.createSession({ externalId: 's1', project: 'proj' });
    const s2 = memory.store.createSession({ externalId: 's2', project: 'proj' });
    const sOther = memory.store.createSession({ externalId: 's3', project: 'other' });
    await seedObs(memory, s1, 'p-one');
    await seedObs(memory, s2, 'p-two');
    await seedObs(memory, sOther, 'survivor');

    const p = preview(memory, { byProject: 'proj' });
    expect(p.count).toBe(2);
    const res = execute(memory, p.handle);
    expect(res.deleted.length).toBe(2);
    // byProject drops every now-empty session row of the project; the 'other'
    // session + its obs survive.
    expect(memory.store.counts()).toMatchObject({
      sessions: 1,
      observations: 1,
      vectors: 1,
      fts: 1,
    });
    expect(memory.store.getSession(s1)).toBeNull();
    expect(memory.store.getSession(s2)).toBeNull();
    expect(memory.store.getSession(sOther)).not.toBeNull();
    memory.close();
  });

  it('byProject null: targets NULL-project sessions, not the literal "null"', async () => {
    const memory = newMemory();
    const sNull = memory.store.createSession({ externalId: 's-null' }); // project undefined → NULL
    const sLiteral = memory.store.createSession({ externalId: 's-lit', project: 'null' });
    await seedObs(memory, sNull, 'nullproj');
    await seedObs(memory, sLiteral, 'literal');

    const p = preview(memory, { byProject: null });
    expect(p.count).toBe(1);
    execute(memory, p.handle);
    // the literal-'null' session's observation survives.
    expect(memory.store.counts()).toMatchObject({ observations: 1 });
    memory.close();
  });

  it('bySearch: resolves via FTS keyword recall', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    await seedObs(memory, s, 'the quick brown fox');
    await seedObs(memory, s, 'lazy dog sleeping');

    const p = preview(memory, { bySearch: { query: 'fox' } });
    expect(p.count).toBe(1);
    expect(p.items[0]?.snippet).toContain('fox');
    execute(memory, p.handle);
    expect(memory.store.counts()).toMatchObject({ observations: 1 });
    memory.close();
  });
});

describe('byIds dedupe + notFound', () => {
  it('dedupes repeated ids and counts non-existent ids as notFound (not dropped)', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    const a = await seedObs(memory, s, 'alpha');

    const p = preview(memory, { byIds: [a, a, 99999, 99999] });
    expect(p.count).toBe(1); // a counted once
    expect(p.items.map((i) => i.id)).toEqual([a]);
    expect(p.notFound).toEqual([99999]); // deduped, reported

    const res = execute(memory, p.handle);
    expect(res.deleted).toEqual([a]);
    memory.close();
  });
});

describe('bySearch does NO embedding', () => {
  it('preview with bySearch never calls provider.embed', () => {
    const memory = newMemory(new ThrowingEmbedding());
    const s = memory.store.createSession({ externalId: 's1' });
    // seed FTS directly (indexer.write would call the throwing embed) — content + fts.
    const id = memory.store.createObservation({ sessionId: s, kind: 'user', content: 'needle' });
    memory.store.indexFts(id, 'needle haystack');

    // If recallFts touched embed, this throws and the test fails.
    const p = preview(memory, { bySearch: { query: 'needle' } });
    expect(p.count).toBe(1);
    expect(p.items[0]?.id).toBe(id);
    memory.close();
  });
});

describe('handle pinning — TOCTOU', () => {
  it('execute deletes exactly the previewed set even if rows are added afterward', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    await seedObs(memory, s, 'first matching needle');

    const p = preview(memory, { bySearch: { query: 'needle' } });
    expect(p.count).toBe(1);

    // A NEW matching observation lands between preview and execute.
    const late = await seedObs(memory, s, 'late needle that also matches');

    const res = execute(memory, p.handle);
    expect(res.deleted.length).toBe(1); // only the pinned one
    // the late-arriving match survives — recall was NOT re-run.
    expect(memory.store.getObservation(late)).not.toBeNull();
    memory.close();
  });

  it('replayed handle → unknown-handle (consumed on first execute)', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    const a = await seedObs(memory, s, 'alpha');

    const p = preview(memory, { byIds: [a] });
    execute(memory, p.handle); // consumes it

    expect(() => execute(memory, p.handle)).toThrow(DeleteRefusalError);
    try {
      execute(memory, p.handle);
    } catch (err) {
      expect((err as DeleteRefusalError).reason).toBe('unknown-handle');
    }
    memory.close();
  });

  it('unknown handle → unknown-handle', () => {
    const memory = newMemory();
    expect(() => execute(memory, 'never-minted')).toThrow(DeleteRefusalError);
    memory.close();
  });

  it('expired handle (TTL elapsed) → unknown-handle', async () => {
    vi.useFakeTimers();
    try {
      const memory = newMemory();
      const s = memory.store.createSession({ externalId: 's1' });
      const a = await seedObs(memory, s, 'alpha');

      const p = preview(memory, { byIds: [a] });
      // advance past the 5-minute TTL.
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      expect(() => execute(memory, p.handle)).toThrow(DeleteRefusalError);
      // the observation was NOT deleted.
      expect(memory.store.getObservation(a)).not.toBeNull();
      memory.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('executeIds — CLI in-process path (no cache)', () => {
  it('deletes a caller-pinned id list directly', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    const a = await seedObs(memory, s, 'alpha');
    const b = await seedObs(memory, s, 'beta');

    const resolved = previewSelector(memory, { byIds: [a, b] });
    expect(resolved.ids).toEqual([a, b]);

    const res = executeIds(memory, resolved.ids);
    expect(res.deleted).toEqual([a, b]);
    expect(memory.store.counts()).toMatchObject({ observations: 0, vectors: 0, fts: 0 });
    memory.close();
  });

  it('previewSelector mints no handle (execute by handle would be unknown)', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    await seedObs(memory, s, 'alpha');
    previewSelector(memory, { bySession: s });
    // no handle exists for this — a fabricated one is unknown.
    expect(() => execute(memory, 'fabricated')).toThrow(DeleteRefusalError);
    memory.close();
  });
});

describe('no-cursor-clamp staleness correctness (C1)', () => {
  it('deleting ids ABOVE the cursor lowers pending by that many', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    const a = await seedObs(memory, s, 'below-1');
    await seedObs(memory, s, 'below-2');
    // cursor at `a`-... set cursor to the current max so everything after is "pending".
    const cursor = a; // ids > a are pending
    memory.store.setMeta(OPTIMIZE_CURSOR_KEY, String(cursor));

    const above1 = await seedObs(memory, s, 'above-1');
    const above2 = await seedObs(memory, s, 'above-2');
    expect(memory.store.countObservationsSince(cursor)).toBe(3); // below-2, above-1, above-2

    executeIds(memory, [above1, above2]);
    expect(memory.store.countObservationsSince(cursor)).toBe(1); // dropped by 2
    // cursor untouched.
    expect(memory.store.getMeta(OPTIMIZE_CURSOR_KEY)).toBe(String(cursor));
    memory.close();
  });

  it('deleting ids BELOW the cursor leaves pending unchanged', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    const below1 = await seedObs(memory, s, 'below-1');
    const below2 = await seedObs(memory, s, 'below-2');
    const cursor = below2; // ids > below2 are pending
    memory.store.setMeta(OPTIMIZE_CURSOR_KEY, String(cursor));
    await seedObs(memory, s, 'above-1');
    expect(memory.store.countObservationsSince(cursor)).toBe(1);

    executeIds(memory, [below1]);
    expect(memory.store.countObservationsSince(cursor)).toBe(1); // unchanged
    expect(memory.store.getMeta(OPTIMIZE_CURSOR_KEY)).toBe(String(cursor));
    memory.close();
  });

  it('deleting ALL observations → pending 0, cursor untouched', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    const a = await seedObs(memory, s, 'one');
    const b = await seedObs(memory, s, 'two');
    const cursor = 0;
    memory.store.setMeta(OPTIMIZE_CURSOR_KEY, String(cursor));
    expect(memory.store.countObservationsSince(cursor)).toBe(2);

    executeIds(memory, [a, b]);
    expect(memory.store.countObservationsSince(cursor)).toBe(0);
    expect(memory.store.getMeta(OPTIMIZE_CURSOR_KEY)).toBe(String(cursor));
    memory.close();
  });
});

describe('empty-session cleanup (bySession / byProject)', () => {
  it('bySession deletes obs + the now-empty session row atomically', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    await seedObs(memory, s, 'one');
    await seedObs(memory, s, 'two');

    const p = preview(memory, { bySession: s });
    execute(memory, p.handle);

    expect(memory.store.getSession(s)).toBeNull();
    expect(memory.store.counts()).toMatchObject({
      sessions: 0,
      observations: 0,
      vectors: 0,
      fts: 0,
    });
    memory.close();
  });

  it('byProject deletes obs + ALL its now-empty session rows', async () => {
    const memory = newMemory();
    const s1 = memory.store.createSession({ externalId: 's1', project: 'proj' });
    const s2 = memory.store.createSession({ externalId: 's2', project: 'proj' });
    await seedObs(memory, s1, 'a');
    await seedObs(memory, s2, 'b');

    const p = preview(memory, { byProject: 'proj' });
    execute(memory, p.handle);

    expect(memory.store.getSession(s1)).toBeNull();
    expect(memory.store.getSession(s2)).toBeNull();
    expect(memory.store.counts()).toMatchObject({
      sessions: 0,
      observations: 0,
      vectors: 0,
      fts: 0,
    });
    memory.close();
  });

  it('byProject null deletes obs + the now-empty NULL-project session row', async () => {
    const memory = newMemory();
    const sNull = memory.store.createSession({ externalId: 's-null' });
    const sLiteral = memory.store.createSession({ externalId: 's-lit', project: 'null' });
    await seedObs(memory, sNull, 'nullproj');
    await seedObs(memory, sLiteral, 'literal');

    const p = preview(memory, { byProject: null });
    execute(memory, p.handle);

    expect(memory.store.getSession(sNull)).toBeNull();
    // the literal-'null' session is untouched (different selector domain).
    expect(memory.store.getSession(sLiteral)).not.toBeNull();
    expect(memory.store.counts()).toMatchObject({ sessions: 1, observations: 1 });
    memory.close();
  });

  it('byIds leaves the session row intact even after its last obs is deleted', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    const a = await seedObs(memory, s, 'only');

    const p = preview(memory, { byIds: [a] });
    execute(memory, p.handle);

    // the user deleted a specific observation, not "the session" — row survives.
    expect(memory.store.getSession(s)).not.toBeNull();
    expect(memory.store.counts()).toMatchObject({
      sessions: 1,
      observations: 0,
      vectors: 0,
      fts: 0,
    });
    memory.close();
  });

  it('bySearch leaves the session row intact even after its last obs is deleted', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    await seedObs(memory, s, 'the lonely needle');

    const p = preview(memory, { bySearch: { query: 'needle' } });
    expect(p.count).toBe(1);
    execute(memory, p.handle);

    expect(memory.store.getSession(s)).not.toBeNull();
    expect(memory.store.counts()).toMatchObject({ sessions: 1, observations: 0 });
    memory.close();
  });

  it('TOCTOU: bySession on a session that gains a NEW obs between preview and execute → only the previewed obs go, the session SURVIVES (non-empty), the new obs is untouched', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    const a = await seedObs(memory, s, 'first');
    const b = await seedObs(memory, s, 'second');

    const p = preview(memory, { bySession: s });
    expect(p.count).toBe(2);

    // A NEW observation lands on the same session AFTER preview.
    const late = await seedObs(memory, s, 'late arrival');

    const res = execute(memory, p.handle);
    expect(res.deleted.sort((x, y) => x - y)).toEqual([a, b]);

    // The session is NON-empty (it still has `late`), so it is NOT swept.
    expect(memory.store.getSession(s)).not.toBeNull();
    expect(memory.store.getObservation(late)).not.toBeNull();
    expect(memory.store.counts()).toMatchObject({
      sessions: 1,
      observations: 1,
      vectors: 1,
      fts: 1,
    });
    memory.close();
  });
});

describe('index consistency after execute', () => {
  it('counts stay in lockstep (vec == obs == fts) after a delete', async () => {
    const memory = newMemory();
    const s = memory.store.createSession({ externalId: 's1' });
    const a = await seedObs(memory, s, 'alpha');
    await seedObs(memory, s, 'beta');
    await seedObs(memory, s, 'gamma');

    const p = preview(memory, { byIds: [a] });
    execute(memory, p.handle);

    const c = memory.store.counts();
    expect(c.observations).toBe(2);
    expect(c.vectors).toBe(c.observations);
    expect(c.fts).toBe(c.observations);
    memory.close();
  });
});
