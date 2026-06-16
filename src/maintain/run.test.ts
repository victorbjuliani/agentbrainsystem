import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import { optimizeCursorKey } from '../hooks/staleness.js';
import { Indexer } from '../indexer/index.js';
import type { Memory } from '../memory.js';
import type {
  ApplyResult,
  GenerateCandidatesResult,
  OptimizeCandidate,
} from '../optimize/index.js';
import { projectSlug } from '../optimize/targets.js';
import { Recall } from '../recall/index.js';
import { acquireCadenceLock, MemoryStore } from '../store/index.js';
import {
  AUTO_DISTILL_LAST_RUN_AT,
  AUTO_DISTILL_RUNS,
  AUTO_DISTILL_TOKENS,
  type MaintainDeps,
  runMaintainAuto,
} from './run.js';

/** Deterministic offline embedding provider (mirrors the run.test.ts fake). */
class FakeEmbedding implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-v1';
  readonly dimensions = 8;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(this.dimensions).fill(0) as number[];
      for (let i = 0; i < t.length; i++) v[i % this.dimensions] = (v[i % this.dimensions] ?? 0) + 1;
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

let dir: string;

function dbPath(): string {
  return join(dir, 'memory.db');
}

/** Config WITH an llm block so the cadence does not short-circuit on no-LLM. */
function llmConfig(): AppConfig {
  return {
    dataDir: dir,
    dbPath: dbPath(),
    embedding: { provider: 'local', model: 'fake', dimensions: 8 },
    recallScope: 'global',
    autoDistill: true,
    distillMinObs: 25,
    llm: { baseUrl: 'http://fake', model: 'fake-llm', timeoutMs: 60000 },
  };
}

/** Config WITHOUT an llm block → cadence cannot run. */
function offlineConfig(): AppConfig {
  return {
    dataDir: dir,
    dbPath: dbPath(),
    embedding: { provider: 'local', model: 'fake', dimensions: 8 },
    recallScope: 'global',
    autoDistill: true,
    distillMinObs: 25,
  };
}

function newMemory(): Memory {
  const store = new MemoryStore({ dbPath: dbPath(), dimensions: 8 }).open();
  const provider = new FakeEmbedding();
  return {
    store,
    provider,
    indexer: new Indexer(store, provider),
    recall: new Recall(store, provider),
    close: () => store.close(),
  };
}

/** Seed one consolidate obs of a kind in the cwd project; returns its obs id. */
async function seedConsolidated(
  memory: Memory,
  kind: 'lesson' | 'decision',
  content: string,
): Promise<number> {
  const sessionId = memory.store.createSession({
    externalId: `s-${content}`,
    project: projectSlug(process.cwd()),
  });
  await memory.indexer.write({
    sessionId,
    kind,
    content,
    source: 'consolidate',
    metadata: { sourceSession: sessionId },
  });
  return memory.store.maxObservationId();
}

/** A candidate stub of a kind backed by the given evidence obs ids. */
function candidateStub(
  id: string,
  kind: 'lesson' | 'decision',
  evidenceIds: number[],
): OptimizeCandidate {
  return {
    id,
    target: {
      kind: kind === 'lesson' ? 'auto-memory' : 'claude-md',
      absPath: '/dev/null',
    },
    title: id,
    rationale: '',
    diff: '',
    proposedText: '',
    baseContent: '',
    evidenceIds,
    priority: kind === 'lesson' ? 'medium' : 'high',
  };
}

/** A generate seam returning a fixed candidate set + keep-set (un-sliced survivors). */
function fakeGenerate(
  candidates: OptimizeCandidate[],
  survivingIds: number[],
  usage = { promptTokens: 100, completionTokens: 40 },
): MaintainDeps['generate'] {
  return async () =>
    ({
      candidates,
      estimate: { promptCharEstimateTokens: 0, llmUsed: true, usage },
      survivingIds,
    }) satisfies GenerateCandidatesResult;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-maintain-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runMaintainAuto — cadence lock held (C3/W1)', () => {
  it('returns { skipped: "locked" }, calls the LLM zero times, advances no cursor', async () => {
    const memory = newMemory();
    const held = acquireCadenceLock(dbPath()); // another cadence already owns it
    try {
      const slug = projectSlug(process.cwd());
      const lessonId = await seedConsolidated(memory, 'lesson', 'l1');
      const consolidate = vi.fn();
      const generate = vi.fn();
      const apply = vi.fn();

      const result = await runMaintainAuto(memory, llmConfig(), { consolidate, generate, apply });

      expect(result.skipped).toBe('locked');
      expect(consolidate).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      // No advance — the lesson cursor stays unset even though S_kind is non-empty.
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBeNull();
      expect(lessonId).toBeGreaterThan(0);
    } finally {
      held.release();
      memory.close();
    }
  });
});

describe('runMaintainAuto — no LLM', () => {
  it('returns { skipped: "no-llm" }, no consolidate call, no cursor change', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(process.cwd());
      await seedConsolidated(memory, 'lesson', 'l1');
      const consolidate = vi.fn();
      const generate = vi.fn();

      const result = await runMaintainAuto(memory, offlineConfig(), { consolidate, generate });

      expect(result.skipped).toBe('no-llm');
      expect(consolidate).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBeNull();
    } finally {
      memory.close();
    }
  });
});

describe('runMaintainAuto — happy path (lessons distilled + auto-memory applied + CLAUDE.md skipped)', () => {
  it('applies auto-memory only, advances the lesson cursor, NOT the decision cursor', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(process.cwd());
      const lessonId = await seedConsolidated(memory, 'lesson', 'a durable lesson');
      const decisionId = await seedConsolidated(memory, 'decision', 'a durable decision');
      const lessonCand = candidateStub('cl', 'lesson', [lessonId]);
      const decisionCand = candidateStub('cd', 'decision', [decisionId]);

      const consolidate = vi.fn(async () => ({
        sessionId: 1,
        written: 1,
        dryRun: false,
        candidates: [],
        estimate: {
          promptCharEstimateTokens: 0,
          usage: { promptTokens: 200, completionTokens: 80 },
        },
      }));
      const apply = vi.fn(
        async (_m: Memory, c: OptimizeCandidate): Promise<ApplyResult> => ({
          applied: true,
          absPath: c.target.absPath,
          backupPath: '/dev/null.bak',
        }),
      );

      const result = await runMaintainAuto(memory, llmConfig(), {
        consolidate,
        generate: fakeGenerate([decisionCand, lessonCand], [lessonId, decisionId]),
        apply,
      });

      // Only the auto-memory (lesson) candidate reached apply.
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls[0]?.[1]?.target.kind).toBe('auto-memory');
      // The lesson cursor advanced; the decision cursor did NOT (skipped → pending-valid).
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBe(
        String(memory.store.maxConsolidatedId(slug, 'lesson')),
      );
      expect(memory.store.getMeta(optimizeCursorKey('decision', slug))).toBeNull();
      expect(result.promoted).toBe(1);
      expect(result.pendingDecisions).toBe(1);
    } finally {
      memory.close();
    }
  });
});

describe('runMaintainAuto — scope filter', () => {
  it('only the auto-memory candidate reaches applyApprovedCandidate', async () => {
    const memory = newMemory();
    try {
      const lessonId = await seedConsolidated(memory, 'lesson', 'l1');
      const decisionId = await seedConsolidated(memory, 'decision', 'd1');
      const apply = vi.fn(
        async (_m: Memory, c: OptimizeCandidate): Promise<ApplyResult> => ({
          applied: true,
          absPath: c.target.absPath,
        }),
      );

      await runMaintainAuto(memory, llmConfig(), {
        consolidate: vi.fn(async () => ({
          sessionId: 1,
          written: 0,
          dryRun: false,
          candidates: [],
          estimate: { promptCharEstimateTokens: 0 },
        })),
        generate: fakeGenerate(
          [
            candidateStub('cd', 'decision', [decisionId]),
            candidateStub('cl', 'lesson', [lessonId]),
          ],
          [lessonId, decisionId],
        ),
        apply,
      });

      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls[0]?.[1]?.target.kind).toBe('auto-memory');
    } finally {
      memory.close();
    }
  });
});

describe('runMaintainAuto — all-curated-out still advances the lesson cursor', () => {
  it('zero candidates (empty keep-set) advances the lesson cursor via curated-out', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(process.cwd());
      await seedConsolidated(memory, 'lesson', 'l1');
      const apply = vi.fn();

      await runMaintainAuto(memory, llmConfig(), {
        consolidate: vi.fn(async () => ({
          sessionId: 1,
          written: 0,
          dryRun: false,
          candidates: [],
          estimate: { promptCharEstimateTokens: 0 },
        })),
        // Judge dropped everything → no candidates, empty keep-set.
        generate: fakeGenerate([], []),
        apply,
      });

      expect(apply).not.toHaveBeenCalled();
      // pending-valid empty (all curated-out) → cursor advances anyway.
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBe(
        String(memory.store.maxConsolidatedId(slug, 'lesson')),
      );
    } finally {
      memory.close();
    }
  });
});

describe('runMaintainAuto — observability rollup (P4)', () => {
  it('increments autoDistill:runs, adds summed tokens, sets a fresh ISO lastRunAt', async () => {
    const memory = newMemory();
    try {
      // Pre-seed a prior rollup to prove accumulation, not overwrite.
      memory.store.setMeta(AUTO_DISTILL_RUNS, '2');
      memory.store.setMeta(AUTO_DISTILL_TOKENS, '1000');
      const lessonId = await seedConsolidated(memory, 'lesson', 'l1');
      const fixedNow = new Date('2026-06-15T12:00:00.000Z');

      await runMaintainAuto(memory, llmConfig(), {
        consolidate: vi.fn(async () => ({
          sessionId: 1,
          written: 1,
          dryRun: false,
          candidates: [],
          estimate: {
            promptCharEstimateTokens: 0,
            usage: { promptTokens: 200, completionTokens: 80 },
          },
        })),
        generate: fakeGenerate([candidateStub('cl', 'lesson', [lessonId])], [lessonId], {
          promptTokens: 100,
          completionTokens: 40,
        }),
        apply: vi.fn(
          async (_m: Memory, c: OptimizeCandidate): Promise<ApplyResult> => ({
            applied: true,
            absPath: c.target.absPath,
          }),
        ),
        now: () => fixedNow,
      });

      expect(memory.store.getMeta(AUTO_DISTILL_RUNS)).toBe('3'); // 2 + 1
      // 1000 prior + (200+80 consolidate) + (100+40 generate) = 1420
      expect(memory.store.getMeta(AUTO_DISTILL_TOKENS)).toBe('1420');
      expect(memory.store.getMeta(AUTO_DISTILL_LAST_RUN_AT)).toBe('2026-06-15T12:00:00.000Z');
    } finally {
      memory.close();
    }
  });
});
