import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import { OPTIMIZE_CURSOR_KEY } from '../hooks/staleness.js';
import { Indexer } from '../indexer/index.js';
import type { Memory } from '../memory.js';
import { Recall } from '../recall/index.js';
import { MemoryStore } from '../store/index.js';
import { applyApprovedCandidate, generateOptimizations } from './run.js';
import { claudeMdPath } from './targets.js';

/** Deterministic offline embedding provider (mirrors the integration test fake). */
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
let projectRoot: string;
let projectsDir: string;

/** Config with no LLM block → the heuristic spine runs $0/offline. */
function offlineConfig(): AppConfig {
  return {
    dataDir: dir,
    dbPath: join(dir, 'memory.db'),
    embedding: { provider: 'local', model: 'fake', dimensions: 8 },
  };
}

function newMemory(): Memory {
  const store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: 8 }).open();
  const provider = new FakeEmbedding();
  return {
    store,
    provider,
    indexer: new Indexer(store, provider),
    recall: new Recall(store, provider),
    close: () => store.close(),
  };
}

async function seedConsolidated(memory: Memory): Promise<number> {
  const sessionId = memory.store.createSession({ externalId: 's1' });
  await memory.indexer.write({
    sessionId,
    kind: 'decision',
    content: 'Chose SQLite + sqlite-vec over a separate vector DB',
    source: 'consolidate',
    metadata: { sourceSession: sessionId },
  });
  return memory.store.maxObservationId();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-run-'));
  projectRoot = join(dir, 'project');
  projectsDir = join(dir, 'projects');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('generateOptimizations — config-aware wrapper', () => {
  it('runs the heuristic spine ($0, no LLM) when config has no llm block', async () => {
    const memory = newMemory();
    try {
      await seedConsolidated(memory);
      const result = await generateOptimizations(memory, offlineConfig(), {
        projectRoot,
        projectsDir,
      });
      expect(result.estimate.llmUsed).toBe(false);
      expect(result.candidates.length).toBeGreaterThan(0);
    } finally {
      memory.close();
    }
  });
});

describe('applyApprovedCandidate — cursor advance on real write', () => {
  it('writes the candidate and advances the staleness cursor to the high-water mark', async () => {
    const memory = newMemory();
    try {
      const maxId = await seedConsolidated(memory);
      const { candidates } = await generateOptimizations(memory, offlineConfig(), {
        projectRoot,
        projectsDir,
      });
      const claudeMd = candidates.find((c) => c.target.kind === 'claude-md');
      expect(claudeMd).toBeDefined();
      if (!claudeMd) return;

      // No cursor before the first optimize-apply.
      expect(memory.store.getMeta(OPTIMIZE_CURSOR_KEY)).toBeNull();

      const result = await applyApprovedCandidate(memory, claudeMd, { projectRoot, projectsDir });

      expect(result.applied).toBe(true);
      expect(existsSync(claudeMdPath(projectRoot))).toBe(true);
      // Cursor advanced to the current max observation id → SessionStart flag resets.
      expect(memory.store.getMeta(OPTIMIZE_CURSOR_KEY)).toBe(String(maxId));
    } finally {
      memory.close();
    }
  });

  it('does NOT advance the cursor when the apply is refused (nothing written)', async () => {
    const memory = newMemory();
    try {
      await seedConsolidated(memory);
      const { candidates } = await generateOptimizations(memory, offlineConfig(), {
        projectRoot,
        projectsDir,
      });
      const base = candidates[0];
      expect(base).toBeDefined();
      if (!base) return;

      // Redirect the target outside the allowlist → the gated applier refuses.
      const forbidden = {
        ...base,
        target: {
          ...base.target,
          kind: 'claude-md' as const,
          absPath: join(projectRoot, 'src/index.ts'),
        },
      };
      const result = await applyApprovedCandidate(memory, forbidden, { projectRoot, projectsDir });

      expect(result.applied).toBe(false);
      expect(result.refused).toBe('forbidden-target');
      // Refusal must not move the cursor — no distillation happened.
      expect(memory.store.getMeta(OPTIMIZE_CURSOR_KEY)).toBeNull();
    } finally {
      memory.close();
    }
  });
});
