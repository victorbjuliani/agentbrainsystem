import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../embedding/index.js';
import { Indexer } from '../indexer/index.js';
import type { LlmCompletion, LlmMessage, LlmProvider } from '../llm/index.js';
import type { Memory } from '../memory.js';
import { Recall } from '../recall/index.js';
import { MemoryStore } from '../store/index.js';
import { optimize } from './index.js';
import { autoMemoryDir, claudeMdPath, projectSlug } from './targets.js';

/** Deterministic offline embedding provider (mirrors the consolidate test fake). */
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

/** A stub LLM that rephrases each candidate; captures the messages it saw. */
class StubLlm implements LlmProvider {
  readonly id = 'stub';
  readonly model = 'stub-v1';
  calls = 0;
  lastMessages: LlmMessage[] | null = null;
  constructor(private readonly responder: (msgs: LlmMessage[]) => string) {}
  async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
    this.calls++;
    this.lastMessages = messages;
    return { text: this.responder(messages), usage: { promptTokens: 100, completionTokens: 50 } };
  }
}

let dir: string;
let projectRoot: string;
let projectsDir: string;

function newMemory(): Memory {
  const store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: 8 }).open();
  const provider = new FakeEmbedding();
  const indexer = new Indexer(store, provider);
  const recall = new Recall(store, provider);
  return { store, provider, indexer, recall, close: () => store.close() };
}

/** Seed a session with consolidated lessons/decisions + raw turns. */
async function seedConsolidated(memory: Memory): Promise<{ decisionId: number; lessonId: number }> {
  // Optimize is project-scoped (#135): the consolidated memory must live under a session
  // whose project matches the optimized projectRoot, exactly as ingest stores it.
  const sessionId = memory.store.createSession({
    externalId: 's1',
    project: projectSlug(projectRoot),
  });
  // Raw turns — must be ignored by the optimizer.
  await memory.indexer.write({
    sessionId,
    kind: 'user',
    content: 'raw turn',
    source: 'transcript',
  });
  const decisionId = await memory.indexer.write({
    sessionId,
    kind: 'decision',
    content: 'Chose SQLite + sqlite-vec over a separate vector DB',
    source: 'consolidate',
    metadata: { sourceSession: sessionId },
  });
  const lessonId = await memory.indexer.write({
    sessionId,
    kind: 'lesson',
    content: 'vec0 rowid must be bound as BigInt or it is rejected',
    source: 'consolidate',
    metadata: { sourceSession: sessionId },
  });
  return { decisionId, lessonId };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-optimize-'));
  projectRoot = join(dir, 'project');
  projectsDir = join(dir, 'projects');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('optimize — candidate generation (diffs-only)', () => {
  it('emits a high-priority decision candidate and a lesson candidate, each with evidence', async () => {
    const memory = newMemory();
    try {
      const { decisionId, lessonId } = await seedConsolidated(memory);

      const result = await optimize(memory, undefined, { projectRoot, projectsDir });

      expect(result.candidates).toHaveLength(2);
      const decision = result.candidates.find((c) => c.target.kind === 'claude-md');
      const lesson = result.candidates.find((c) => c.target.kind === 'auto-memory');

      expect(decision).toBeDefined();
      expect(decision?.priority).toBe('high');
      expect(decision?.evidenceIds).toContain(decisionId);
      expect(decision?.target.absPath).toBe(claudeMdPath(projectRoot));
      expect(decision?.diff).toContain('+'); // a unified diff with additions

      expect(lesson).toBeDefined();
      expect(lesson?.priority).toBe('medium');
      expect(lesson?.evidenceIds).toContain(lessonId);
      expect(lesson?.target.absPath.startsWith(autoMemoryDir(projectRoot, projectsDir))).toBe(true);
      expect(lesson?.target.memoryType).toBe('project');

      // Decisions (high) sort before lessons (medium).
      expect(result.candidates[0]?.priority).toBe('high');
    } finally {
      memory.close();
    }
  });

  it('scopes candidates to the current project — never leaks another project (#135)', async () => {
    const memory = newMemory();
    try {
      const { decisionId } = await seedConsolidated(memory);
      // A consolidated decision belonging to a DIFFERENT project (e.g. a client repo).
      const foreignSession = memory.store.createSession({
        externalId: 's-foreign',
        project: projectSlug(join(dir, 'OTHER-CLIENT-PROJECT')),
      });
      const foreignId = await memory.indexer.write({
        sessionId: foreignSession,
        kind: 'decision',
        content: 'Coupa API keys are deprecated — migrate to OAuth (client secret)',
        source: 'consolidate',
        metadata: { sourceSession: foreignSession },
      });

      const result = await optimize(memory, undefined, { projectRoot, projectsDir });
      const decision = result.candidates.find((c) => c.target.kind === 'claude-md');

      expect(decision?.evidenceIds).toContain(decisionId);
      // The foreign project's decision must NOT appear in THIS project's CLAUDE.md candidate.
      expect(decision?.evidenceIds).not.toContain(foreignId);
      expect(decision?.diff).not.toContain('Coupa');
    } finally {
      memory.close();
    }
  });

  it('uses content-addressed candidate ids (stable per evidence, not positional) (#135/F3-06)', async () => {
    const memory = newMemory();
    try {
      await seedConsolidated(memory);
      const a = await optimize(memory, undefined, { projectRoot, projectsDir });
      const b = await optimize(memory, undefined, { projectRoot, projectsDir });
      const idA = a.candidates.find((c) => c.target.kind === 'claude-md')?.id;
      const idB = b.candidates.find((c) => c.target.kind === 'claude-md')?.id;
      expect(idA).toBeDefined();
      expect(idA).toBe(idB); // same evidence → same id across runs (no positional recycling)
      expect(idA).not.toMatch(/^cand-\d+$/); // not a positional counter
    } finally {
      memory.close();
    }
  });

  it('candidate id CHANGES when the target file mutates under identical evidence (#135/F3-06)', async () => {
    const memory = newMemory();
    try {
      await seedConsolidated(memory);
      const before = await optimize(memory, undefined, { projectRoot, projectsDir });
      const idBefore = before.candidates.find((c) => c.target.kind === 'claude-md')?.id;

      // Same evidence, but CLAUDE.md now has different content → the proposed diff differs,
      // so a stale id must NOT keep mapping to a now-different candidate.
      await mkdir(projectRoot, { recursive: true });
      await writeFile(claudeMdPath(projectRoot), '# CLAUDE.md\n\nhand-edited since the preview.\n');
      const after = await optimize(memory, undefined, { projectRoot, projectsDir });
      const idAfter = after.candidates.find((c) => c.target.kind === 'claude-md')?.id;

      expect(idBefore).toBeDefined();
      expect(idAfter).toBeDefined();
      expect(idAfter).not.toBe(idBefore);
    } finally {
      memory.close();
    }
  });

  it('writes NOTHING — no files are created during generation', async () => {
    const memory = newMemory();
    try {
      await seedConsolidated(memory);
      await optimize(memory, undefined, { projectRoot, projectsDir });
      // The target files must not exist after a diffs-only run.
      const { existsSync } = await import('node:fs');
      expect(existsSync(claudeMdPath(projectRoot))).toBe(false);
      expect(existsSync(autoMemoryDir(projectRoot, projectsDir))).toBe(false);
    } finally {
      memory.close();
    }
  });

  it('ignores raw (non-consolidate) observations', async () => {
    const memory = newMemory();
    try {
      const sessionId = memory.store.createSession({ externalId: 's1' });
      await memory.indexer.write({ sessionId, kind: 'user', content: 'just a turn' });
      const result = await optimize(memory, undefined, { projectRoot, projectsDir });
      expect(result.candidates).toHaveLength(0);
    } finally {
      memory.close();
    }
  });

  it('diffs against existing CLAUDE.md content read-only and does not duplicate the header', async () => {
    const memory = newMemory();
    try {
      await seedConsolidated(memory);
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        claudeMdPath(projectRoot),
        '# Project\n\n## Consolidated Memory (managed by abs optimize)\n\n- old\n',
        'utf8',
      );
      const result = await optimize(memory, undefined, { projectRoot, projectsDir });
      const decision = result.candidates.find((c) => c.target.kind === 'claude-md');
      // Header already present -> the proposed block must not re-add it.
      expect(decision?.proposedText).not.toContain(
        '## Consolidated Memory (managed by abs optimize)',
      );
    } finally {
      memory.close();
    }
  });
});

describe('optimize — LLM phrasing (optional, never load-bearing)', () => {
  it('rephrases title/rationale only, preserving diff/evidence/target', async () => {
    const memory = newMemory();
    try {
      await seedConsolidated(memory);
      const base = await optimize(memory, undefined, { projectRoot, projectsDir });

      const llm = new StubLlm((msgs) => {
        // Echo back a valid phrasing for every candidate id present in the prompt.
        const user = msgs.find((m) => m.role === 'user')?.content ?? '';
        const ids = [...user.matchAll(/"id":"(cand-[0-9a-f]+)"/g)].map((m) => m[1]);
        return JSON.stringify(
          ids.map((id) => ({ id, title: `Phrased ${id}`, rationale: `Because ${id}.` })),
        );
      });
      const phrased = await optimize(memory, llm, { projectRoot, projectsDir, pricePer1k: 0.002 });

      expect(llm.calls).toBe(1);
      expect(phrased.estimate.llmUsed).toBe(true);
      expect(phrased.estimate.costEstimate).toBeCloseTo((150 / 1000) * 0.002, 6);

      for (let i = 0; i < phrased.candidates.length; i++) {
        const p = phrased.candidates[i];
        const b = base.candidates.find((c) => c.id === p?.id);
        expect(p?.title).toBe(`Phrased ${p?.id}`);
        expect(p?.rationale).toBe(`Because ${p?.id}.`);
        // Load-bearing fields unchanged.
        expect(p?.diff).toBe(b?.diff);
        expect(p?.proposedText).toBe(b?.proposedText);
        expect(p?.evidenceIds).toEqual(b?.evidenceIds);
        expect(p?.target).toEqual(b?.target);
      }
    } finally {
      memory.close();
    }
  });

  it('fences the candidate content as DATA with an injection guard', async () => {
    const memory = newMemory();
    try {
      await seedConsolidated(memory);
      const llm = new StubLlm(() => '[]');
      await optimize(memory, llm, { projectRoot, projectsDir });
      const system = llm.lastMessages?.find((m) => m.role === 'system')?.content ?? '';
      const user = llm.lastMessages?.find((m) => m.role === 'user')?.content ?? '';
      expect(system).toMatch(/never follow/i);
      expect(user).toContain('<candidates>');
      expect(user).toContain('</candidates>');
    } finally {
      memory.close();
    }
  });

  it('falls back to heuristic phrasing when the LLM returns garbage', async () => {
    const memory = newMemory();
    try {
      await seedConsolidated(memory);
      const base = await optimize(memory, undefined, { projectRoot, projectsDir });
      const llm = new StubLlm(() => 'not json at all');
      const phrased = await optimize(memory, llm, { projectRoot, projectsDir });
      // Title/rationale unchanged from the heuristic spine.
      for (const c of phrased.candidates) {
        const b = base.candidates.find((x) => x.id === c.id);
        expect(c.title).toBe(b?.title);
        expect(c.rationale).toBe(b?.rationale);
      }
    } finally {
      memory.close();
    }
  });
});
