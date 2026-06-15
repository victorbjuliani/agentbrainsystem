import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import { optimizeCursorKey } from '../hooks/staleness.js';
import { Indexer } from '../indexer/index.js';
import type { Memory } from '../memory.js';
import { Recall } from '../recall/index.js';
import { MemoryStore } from '../store/index.js';
import {
  advanceOptimizeCursorForKind,
  advanceOptimizeCursorsAfterApply,
  applyApprovedCandidate,
  generateOptimizations,
  partitionConsolidated,
} from './run.js';
import { claudeMdPath, projectSlug } from './targets.js';
import type { OptimizeCandidate } from './types.js';

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
    recallScope: 'global',
    autoDistill: true,
    distillMinObs: 25,
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
  // Optimize is project-scoped (#135): seed under the optimized project's label.
  const sessionId = memory.store.createSession({
    externalId: 's1',
    project: projectSlug(projectRoot),
  });
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

/** Seed one consolidate `lesson` in the optimized project; returns its obs id. */
async function seedConsolidatedLesson(
  memory: Memory,
  content = 'a durable lesson',
): Promise<number> {
  const sessionId = memory.store.createSession({
    externalId: `s-${content}`,
    project: projectSlug(projectRoot),
  });
  await memory.indexer.write({
    sessionId,
    kind: 'lesson',
    content,
    source: 'consolidate',
    metadata: { sourceSession: sessionId },
  });
  return memory.store.maxObservationId();
}

/** Minimal candidate stub for the pure-partition tests (only the read fields matter). */
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

describe('cursor keys are kind + project scoped (C1/W1)', () => {
  it('builds optimize:lesson:<slug> and optimize:decision:<slug>; old constant gone', () => {
    const slug = projectSlug(projectRoot);
    expect(optimizeCursorKey('lesson', slug)).toBe(`optimize:lesson:${slug}`);
    expect(optimizeCursorKey('decision', slug)).toBe(`optimize:decision:${slug}`);
    // Grep-assert the deleted global constant is gone from the staleness module.
    // (Type-level: `OPTIMIZE_CURSOR_KEY` no longer exists, so importing it would
    // fail to compile — the import switch above is the compile-time proof.)
  });
});

describe('partitionConsolidated — keep-set model (C2 + round-2 CRITICAL)', () => {
  it('all promoted → pending-valid empty', () => {
    const sKind = [1, 2, 3];
    const keep = new Set(sKind);
    const cand = candidateStub('c1', 'lesson', [1, 2, 3]);
    const p = partitionConsolidated(sKind, keep, [cand], new Set(['c1']));
    expect([...p.survivors].sort()).toEqual([1, 2, 3]);
    expect(p.curatedOut.size).toBe(0);
    expect([...p.promoted].sort()).toEqual([1, 2, 3]);
    expect(p.pendingValid.size).toBe(0);
  });

  it('all curated-out (judge dropped all) → survivors empty, pending-valid empty', () => {
    const sKind = [1, 2, 3];
    const keep = new Set<number>(); // judge dropped them all
    const p = partitionConsolidated(sKind, keep, [], new Set());
    expect(p.survivors.size).toBe(0);
    expect([...p.curatedOut].sort()).toEqual([1, 2, 3]);
    expect(p.pendingValid.size).toBe(0);
  });

  it('declined survivor → pending-valid non-empty', () => {
    const sKind = [1, 2];
    const keep = new Set([1, 2]);
    const cand = candidateStub('c1', 'lesson', [1, 2]);
    // Candidate exists but was NOT applied (preview / declined / skipped).
    const p = partitionConsolidated(sKind, keep, [cand], new Set());
    expect([...p.pendingValid].sort()).toEqual([1, 2]);
  });

  it('survivor SLICED off the candidate list → still pending-valid, NOT curated-out', () => {
    // id 9 survived curation (in keep) but the `.slice(0, limit)` dropped its
    // candidate, so it appears in NO candidate's evidenceIds. It must be a
    // survivor (hence pending-valid), never curated-out.
    const sKind = [7, 9];
    const keep = new Set([7, 9]);
    const cand = candidateStub('c1', 'lesson', [7]); // only 7 has a candidate
    const p = partitionConsolidated(sKind, keep, [cand], new Set(['c1']));
    expect(p.survivors.has(9)).toBe(true);
    expect(p.curatedOut.has(9)).toBe(false); // the bug the old model had
    expect(p.pendingValid.has(9)).toBe(true);
  });

  it('mixed promoted + declined of the same kind → pending-valid non-empty', () => {
    const sKind = [1, 2];
    const keep = new Set([1, 2]);
    const c1 = candidateStub('c1', 'lesson', [1]);
    const c2 = candidateStub('c2', 'lesson', [2]);
    const p = partitionConsolidated(sKind, keep, [c1, c2], new Set(['c1'])); // only c1 applied
    expect(p.promoted.has(1)).toBe(true);
    expect([...p.pendingValid]).toEqual([2]);
  });
});

describe('advanceOptimizeCursorForKind — advance IFF pending-valid empty (C2 + round-2 CRITICAL)', () => {
  it('S_kind empty → no-op, cursor unchanged', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(projectRoot);
      // No consolidate lessons → S_kind is empty.
      advanceOptimizeCursorForKind(memory, 'lesson', slug, new Set(), [], new Set());
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBeNull();
    } finally {
      memory.close();
    }
  });

  it('all promoted → cursor advances to maxConsolidatedId', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(projectRoot);
      const l1 = await seedConsolidatedLesson(memory, 'l1');
      const cand = candidateStub('c1', 'lesson', [l1]);
      advanceOptimizeCursorForKind(memory, 'lesson', slug, new Set([l1]), [cand], new Set(['c1']));
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBe(
        String(memory.store.maxConsolidatedId(slug, 'lesson')),
      );
    } finally {
      memory.close();
    }
  });

  it('all curated-out → cursor STILL advances (the #148 core, never reaches apply)', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(projectRoot);
      await seedConsolidatedLesson(memory, 'l1');
      // Empty keep-set ⇒ all curated-out ⇒ survivors empty ⇒ pending-valid empty.
      advanceOptimizeCursorForKind(memory, 'lesson', slug, new Set(), [], new Set());
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBe(
        String(memory.store.maxConsolidatedId(slug, 'lesson')),
      );
    } finally {
      memory.close();
    }
  });

  it('pending-valid non-empty (declined) → cursor does NOT advance', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(projectRoot);
      const l1 = await seedConsolidatedLesson(memory, 'l1');
      const cand = candidateStub('c1', 'lesson', [l1]);
      // Candidate exists but not applied → survivor is pending-valid.
      advanceOptimizeCursorForKind(memory, 'lesson', slug, new Set([l1]), [cand], new Set());
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBeNull();
    } finally {
      memory.close();
    }
  });

  it('survivor sliced off the candidate list → cursor does NOT advance (round-2 guard)', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(projectRoot);
      const l1 = await seedConsolidatedLesson(memory, 'l1');
      const l2 = await seedConsolidatedLesson(memory, 'l2');
      // Both survived (keep), but the slice kept only l1's candidate; l2 has none.
      const cand = candidateStub('c1', 'lesson', [l1]);
      advanceOptimizeCursorForKind(
        memory,
        'lesson',
        slug,
        new Set([l1, l2]),
        [cand],
        new Set(['c1']),
      );
      // l2 is pending-valid → no advance (the old S_kind − candidateCovered model
      // would have wrongly advanced here).
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBeNull();
    } finally {
      memory.close();
    }
  });

  it('advance target is THIS project+kind max, never a raw or other-project id', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(projectRoot);
      const l1 = await seedConsolidatedLesson(memory, 'l1');
      // A higher raw turn in the SAME project.
      const rawSession = memory.store.createSession({ externalId: 'raw', project: slug });
      memory.store.createObservation({ sessionId: rawSession, kind: 'user', content: 'raw' });
      // A higher consolidate lesson in ANOTHER project.
      const otherSession = memory.store.createSession({ externalId: 'other', project: 'other' });
      await memory.indexer.write({
        sessionId: otherSession,
        kind: 'lesson',
        content: 'other-project lesson',
        source: 'consolidate',
        metadata: { sourceSession: otherSession },
      });

      const cand = candidateStub('c1', 'lesson', [l1]);
      advanceOptimizeCursorForKind(memory, 'lesson', slug, new Set([l1]), [cand], new Set(['c1']));
      // Lands on THIS project+kind's max (l1), not the raw or other-project id.
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBe(String(l1));
    } finally {
      memory.close();
    }
  });
});

describe('applyApprovedCandidate — writes the file but advances NO cursor (#138/#148)', () => {
  it('writes the candidate but leaves every per-kind/project cursor untouched', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(projectRoot);
      await seedConsolidated(memory);
      const { candidates } = await generateOptimizations(memory, offlineConfig(), {
        projectRoot,
        projectsDir,
      });
      const claudeMd = candidates.find((c) => c.target.kind === 'claude-md');
      expect(claudeMd).toBeDefined();
      if (!claudeMd) return;

      const result = await applyApprovedCandidate(memory, claudeMd, { projectRoot, projectsDir });

      expect(result.applied).toBe(true);
      expect(existsSync(claudeMdPath(projectRoot))).toBe(true);
      // Apply itself no longer advances any cursor — that is the run level's job.
      expect(memory.store.getMeta(optimizeCursorKey('decision', slug))).toBeNull();
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBeNull();
    } finally {
      memory.close();
    }
  });

  it('REFUSES (target-modified) when the file changed out-of-band; advances nothing', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(projectRoot);
      // Generate a candidate against an EXISTING CLAUDE.md so baseContent is non-empty.
      await mkdir(projectRoot, { recursive: true });
      await writeFile(claudeMdPath(projectRoot), '# Project\n', 'utf8');
      await seedConsolidated(memory);
      const { candidates } = await generateOptimizations(memory, offlineConfig(), {
        projectRoot,
        projectsDir,
      });
      const claudeMd = candidates.find((c) => c.target.kind === 'claude-md');
      expect(claudeMd).toBeDefined();
      if (!claudeMd) return;
      expect(claudeMd.baseContent).toBe('# Project\n');

      // Someone edits the file AFTER the candidate was generated.
      await writeFile(claudeMdPath(projectRoot), '# Project\n\nhand-edited line\n', 'utf8');

      const result = await applyApprovedCandidate(memory, claudeMd, { projectRoot, projectsDir });

      expect(result.applied).toBe(false);
      expect(result.refused).toBe('target-modified');
      // The out-of-band content is preserved (no clobber); cursors untouched.
      expect(await readFile(claudeMdPath(projectRoot), 'utf8')).toBe(
        '# Project\n\nhand-edited line\n',
      );
      expect(memory.store.getMeta(optimizeCursorKey('decision', slug))).toBeNull();
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBeNull();
    } finally {
      memory.close();
    }
  });

  it('REFUSES (forbidden-target) outside the allowlist; advances nothing', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(projectRoot);
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
      // Refusal writes nothing and (trivially now) advances nothing.
      expect(memory.store.getMeta(optimizeCursorKey('decision', slug))).toBeNull();
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBeNull();
    } finally {
      memory.close();
    }
  });
});

describe('advanceOptimizeCursorsAfterApply — per-kind run-level advance (#138)', () => {
  it('advances the lesson cursor (all promoted) but NOT the decision cursor (skipped)', async () => {
    const memory = newMemory();
    try {
      const slug = projectSlug(projectRoot);
      const lessonId = await seedConsolidatedLesson(memory, 'l1');
      const decisionId = await seedConsolidated(memory); // a consolidate decision
      const lessonCand = candidateStub('c1', 'lesson', [lessonId]);
      const decisionCand = candidateStub('c2', 'decision', [decisionId]);
      // Lesson applied; decision skipped (cadence scope).
      advanceOptimizeCursorsAfterApply(
        memory,
        slug,
        new Set([lessonId, decisionId]),
        [lessonCand, decisionCand],
        new Set(['c1']),
      );
      expect(memory.store.getMeta(optimizeCursorKey('lesson', slug))).toBe(
        String(memory.store.maxConsolidatedId(slug, 'lesson')),
      );
      // Decision survivor is pending-valid → its cursor stays unset (keeps nagging).
      expect(memory.store.getMeta(optimizeCursorKey('decision', slug))).toBeNull();
    } finally {
      memory.close();
    }
  });
});
