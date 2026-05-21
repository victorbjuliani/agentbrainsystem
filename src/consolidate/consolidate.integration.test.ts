import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '../embedding/index.js';
import { Indexer } from '../indexer/index.js';
import type { LlmCompletion, LlmMessage, LlmProvider } from '../llm/index.js';
import type { Memory } from '../memory.js';
import { Recall } from '../recall/index.js';
import { MemoryStore } from '../store/index.js';
import { consolidate } from './consolidate.js';
import type { LessonCandidate } from './types.js';

// ---------------------------------------------------------------------------
// Fast offline fakes — never a network LLM or a real embedding model.
// ---------------------------------------------------------------------------

/** Deterministic offline embedding provider (mirrors the indexer's own test fake). */
class FakeEmbedding implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-v1';
  readonly dimensions = 8;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(this.dimensions).fill(0) as number[];
      for (let i = 0; i < t.length; i++) {
        v[i % this.dimensions] = (v[i % this.dimensions] ?? 0) + t.charCodeAt(i);
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

/** A stub LLM returning canned candidates as JSON. Captures the messages it saw. */
class StubLlm implements LlmProvider {
  readonly id = 'stub';
  readonly model = 'stub-v1';
  calls = 0;
  lastMessages: LlmMessage[] | null = null;
  usage: { promptTokens?: number; completionTokens?: number } | undefined;

  constructor(
    private readonly candidates: LessonCandidate[],
    usage?: { promptTokens?: number; completionTokens?: number },
  ) {
    this.usage = usage;
  }

  async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
    this.calls++;
    this.lastMessages = messages;
    return {
      text: JSON.stringify(this.candidates),
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}

let dir: string;

function newMemory(): Memory {
  const store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: 8 }).open();
  const provider = new FakeEmbedding();
  const indexer = new Indexer(store, provider);
  const recall = new Recall(store, provider);
  return { store, provider, indexer, recall, close: () => store.close() };
}

/** Seed a session with a couple of raw transcript turns. */
async function seedSession(memory: Memory, externalId: string): Promise<number> {
  const sessionId = memory.store.createSession({ externalId });
  await memory.indexer.write({ sessionId, kind: 'user', content: 'how do I cache?' });
  await memory.indexer.write({ sessionId, kind: 'assistant', content: 'use an LRU and WAL' });
  return sessionId;
}

function lessons(n: number): LessonCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: i % 2 === 0 ? 'lesson' : ('decision' as const),
    content: `insight ${i}`,
  })) as LessonCandidate[];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-consolidate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('consolidate — happy path', () => {
  it('writes exactly the distilled lessons, tagged + recallable', async () => {
    const memory = newMemory();
    try {
      const sessionId = await seedSession(memory, 's1');
      const before = memory.store.counts();
      const llm = new StubLlm(lessons(3));

      const result = await consolidate(memory, llm, { sessionId });

      expect(result.written).toBe(3);
      expect(result.dryRun).toBe(false);
      expect(result.skipped).toBeUndefined();
      expect(result.candidates).toHaveLength(3);

      // Exactly 3 consolidate observations for the session, each tagged.
      const written = memory.store.listObservationsBySourceSession(sessionId, {
        source: 'consolidate',
      });
      expect(written).toHaveLength(3);
      for (const o of written) {
        expect(['lesson', 'decision']).toContain(o.kind);
        expect(o.source).toBe('consolidate');
        expect(o.metadata?.sourceSession).toBe(sessionId);
        expect(typeof o.metadata?.consolidatedAt).toBe('string');
      }

      // Counts increased by exactly 3 (vectors + fts consistent → recallable).
      const after = memory.store.counts();
      expect(after.observations).toBe(before.observations + 3);
      expect(after.vectors).toBe(before.vectors + 3);
      expect(after.fts).toBe(before.fts + 3);

      // Recall finds a written lesson.
      const hits = await memory.recall.recall('insight');
      expect(hits.some((h) => h.observation.source === 'consolidate')).toBe(true);
    } finally {
      memory.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('consolidate — idempotency', () => {
  it('skips a second run without force and never calls the LLM again', async () => {
    const memory = newMemory();
    try {
      const sessionId = await seedSession(memory, 's1');
      const llm = new StubLlm(lessons(3));
      await consolidate(memory, llm, { sessionId });
      const after1 = memory.store.counts();

      const result2 = await consolidate(memory, llm, { sessionId });

      expect(result2.skipped).toBe('already-consolidated');
      expect(result2.written).toBe(0);
      expect(llm.calls).toBe(1); // not called the second time
      expect(memory.store.counts()).toEqual(after1);
    } finally {
      memory.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Force
// ---------------------------------------------------------------------------

describe('consolidate — force', () => {
  it('deletes the prior consolidation and writes the new one (no duplicates)', async () => {
    const memory = newMemory();
    try {
      const sessionId = await seedSession(memory, 's1');
      await consolidate(memory, new StubLlm(lessons(3)), { sessionId });

      const result = await consolidate(memory, new StubLlm(lessons(2)), { sessionId, force: true });

      expect(result.written).toBe(2);
      const written = memory.store.listObservationsBySourceSession(sessionId, {
        source: 'consolidate',
      });
      expect(written).toHaveLength(2); // prior 3 gone, exactly 2 remain

      // vec/fts stay consistent with observation count.
      const counts = memory.store.counts();
      expect(counts.vectors).toBe(counts.observations);
      expect(counts.fts).toBe(counts.observations);
    } finally {
      memory.close();
    }
  });

  it('preserves the prior consolidation when a forced re-run fails mid-write', async () => {
    const memory = newMemory();
    try {
      const sessionId = await seedSession(memory, 's1');
      await consolidate(memory, new StubLlm(lessons(3)), { sessionId });
      const priorIds = memory.store
        .listObservationsBySourceSession(sessionId, { source: 'consolidate' })
        .map((o) => o.id);
      expect(priorIds).toHaveLength(3);

      // Forced re-run whose 2nd write fails.
      const realWrite = memory.indexer.write.bind(memory.indexer);
      let writeCalls = 0;
      vi.spyOn(memory.indexer, 'write').mockImplementation(async (input) => {
        writeCalls++;
        if (writeCalls === 2) throw new Error('boom on forced write 2');
        return realWrite(input);
      });

      await expect(
        consolidate(memory, new StubLlm(lessons(3)), { sessionId, force: true }),
      ).rejects.toThrow(/boom on forced write 2/);

      // The prior consolidation must still be intact (no zero/partial state).
      const after = memory.store.listObservationsBySourceSession(sessionId, {
        source: 'consolidate',
      });
      expect(after.map((o) => o.id).sort()).toEqual([...priorIds].sort());
      const counts = memory.store.counts();
      expect(counts.vectors).toBe(counts.observations);
      expect(counts.fts).toBe(counts.observations);
    } finally {
      vi.restoreAllMocks();
      memory.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('consolidate — dry run', () => {
  it('calls the LLM once, writes nothing, counts unchanged', async () => {
    const memory = newMemory();
    try {
      const sessionId = await seedSession(memory, 's1');
      const before = memory.store.counts();
      const llm = new StubLlm(lessons(3));

      const result = await consolidate(memory, llm, { sessionId, dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.written).toBe(0);
      expect(result.candidates).toHaveLength(3);
      expect(llm.calls).toBe(1);
      expect(memory.store.counts()).toEqual(before);
    } finally {
      memory.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Rollback (W1: write-nothing-on-error)
// ---------------------------------------------------------------------------

describe('consolidate — rollback', () => {
  it('rolls back every write when a mid-loop write fails', async () => {
    const memory = newMemory();
    try {
      const sessionId = await seedSession(memory, 's1');
      const llm = new StubLlm(lessons(3));

      // Fail the 2nd indexer.write of the run.
      const realWrite = memory.indexer.write.bind(memory.indexer);
      let writeCalls = 0;
      vi.spyOn(memory.indexer, 'write').mockImplementation(async (input) => {
        writeCalls++;
        if (writeCalls === 2) throw new Error('boom on write 2');
        return realWrite(input);
      });

      await expect(consolidate(memory, llm, { sessionId })).rejects.toThrow(/boom on write 2/);

      // Zero consolidate observations remain — the first write was rolled back.
      const written = memory.store.listObservationsBySourceSession(sessionId, {
        source: 'consolidate',
      });
      expect(written).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
      memory.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Default latest
// ---------------------------------------------------------------------------

describe('consolidate — default session selection', () => {
  it('picks the newest un-consolidated session', async () => {
    const memory = newMemory();
    try {
      const s1 = await seedSession(memory, 's1');
      // s2 is newer (more recent activity).
      const s2 = memory.store.createSession({ externalId: 's2' });
      await memory.indexer.write({ sessionId: s2, kind: 'user', content: 'newer turn' });

      const result = await consolidate(memory, new StubLlm(lessons(1)), {});
      expect(result.sessionId).toBe(s2);

      // Now both s2 (just done) — consolidate again should pick s1.
      const result2 = await consolidate(memory, new StubLlm(lessons(1)), {});
      expect(result2.sessionId).toBe(s1);

      // Everything consolidated → skip.
      const result3 = await consolidate(memory, new StubLlm(lessons(1)), {});
      expect(result3.skipped).toBe('no-unconsolidated-session');
      expect(result3.written).toBe(0);
    } finally {
      memory.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('consolidate — guards', () => {
  it('throws when an explicit --session does not exist', async () => {
    const memory = newMemory();
    try {
      await expect(
        consolidate(memory, new StubLlm(lessons(1)), { sessionId: 999 }),
      ).rejects.toThrow(/session 999 not found/i);
    } finally {
      memory.close();
    }
  });

  it('skips a session with no distillable observations and never calls the LLM', async () => {
    const memory = newMemory();
    try {
      // A session whose only observation is itself a consolidate row.
      const sessionId = memory.store.createSession({ externalId: 's-empty' });
      await memory.indexer.write({
        sessionId,
        kind: 'lesson',
        content: 'prior lesson',
        source: 'consolidate',
        metadata: { sourceSession: sessionId },
      });
      const llm = new StubLlm(lessons(1));

      const result = await consolidate(memory, llm, { sessionId, force: true });

      expect(result.skipped).toBe('no-observations');
      expect(result.written).toBe(0);
      expect(llm.calls).toBe(0);
    } finally {
      memory.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Lessons-of-lessons exclusion
// ---------------------------------------------------------------------------

describe('consolidate — transcript filtering', () => {
  it('excludes prior consolidate rows but keeps real kind:decision observations', async () => {
    const memory = newMemory();
    try {
      const sessionId = memory.store.createSession({ externalId: 's-mix' });
      // A prior consolidate row that must NOT appear in the transcript.
      await memory.indexer.write({
        sessionId,
        kind: 'lesson',
        content: 'PRIOR_CONSOLIDATE_ROW',
        source: 'consolidate',
        metadata: { sourceSession: sessionId },
      });
      // A real user decision turn that MUST appear in the transcript.
      await memory.indexer.write({
        sessionId,
        kind: 'decision',
        content: 'REAL_USER_DECISION',
        source: 'transcript',
      });
      await memory.indexer.write({ sessionId, kind: 'user', content: 'REAL_USER_TURN' });

      const llm = new StubLlm(lessons(1));
      // force, so the prior consolidate row does not short-circuit as already-consolidated.
      await consolidate(memory, llm, { sessionId, force: true });

      const userMsg = llm.lastMessages?.find((m) => m.role === 'user');
      expect(userMsg?.content).toContain('REAL_USER_DECISION');
      expect(userMsg?.content).toContain('REAL_USER_TURN');
      expect(userMsg?.content).not.toContain('PRIOR_CONSOLIDATE_ROW');
    } finally {
      memory.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Cost estimate
// ---------------------------------------------------------------------------

describe('consolidate — estimate', () => {
  it('reports usage and a cost estimate when price + usage are available', async () => {
    const memory = newMemory();
    try {
      const sessionId = await seedSession(memory, 's1');
      const llm = new StubLlm(lessons(1), { promptTokens: 1000, completionTokens: 500 });

      const result = await consolidate(memory, llm, { sessionId, pricePer1k: 0.002 });

      expect(result.estimate.promptCharEstimateTokens).toBeGreaterThan(0);
      expect(result.estimate.usage).toEqual({ promptTokens: 1000, completionTokens: 500 });
      // (1000 + 500) / 1000 * 0.002 = 0.003
      expect(result.estimate.costEstimate).toBeCloseTo(0.003, 6);
    } finally {
      memory.close();
    }
  });
});
