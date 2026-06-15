/**
 * Candidate generation — the heuristic SPINE of the optimize engine (issue #18).
 *
 * Mostly PURE: the only I/O is reading the current target files READ-ONLY (so the
 * diff has a base to render against). It writes NOTHING — diffs-only is the #18
 * invariant; the gated applier (#20) is the only thing that ever mutates a file.
 *
 * What it does:
 *   - Pull the consolidated lessons/decisions from the store (source:'consolidate',
 *     kind ∈ {lesson,decision}) — these are the #12 output we optimise into durable
 *     project memory. They are prioritised over raw turns; raw turns are ignored.
 *   - Cluster them by `kind`: decisions → a CLAUDE.md candidate (decisions belong in
 *     the always-loaded project instructions), lessons → an auto-memory candidate
 *     (lessons are recall-on-demand). Each candidate carries the EVIDENCE = the ids
 *     of the observations it derives from.
 *   - Render a unified diff against the current target content: append-only for CLAUDE.md
 *     (and re-runs on an entry that already has frontmatter); a full-file replace when an
 *     auto-memory entry needs frontmatter prepended (new file / legacy heal — #140). A
 *     lesson candidate also carries an additive `MEMORY.md` index-pointer write.
 *
 * The LLM (when configured) only PHRASES the rationale/body — see `llm-phrasing.ts`.
 * This spine is always present and $0/offline; the LLM is a polish pass, never the
 * source of the proposal. Ingested lesson content is treated as UNTRUSTED data: it
 * is fenced when handed to the LLM (the #12 invariant) and only ever lands as a
 * bullet inside a managed section here, never interpreted.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../memory.js';
import type { Observation } from '../store/index.js';
import { renderAppendDiff, renderFullDiff } from './diff.js';
import {
  autoMemoryEntryPath,
  CONSOLIDATED_LESSONS_FILE,
  claudeMdPath,
  ensureIndexPointer,
  hasFrontmatter,
  MEMORY_INDEX,
  memoryIndexPath,
  projectSlug,
} from './targets.js';
import type {
  GenerateCandidatesOptions,
  IndexWrite,
  OptimizeCandidate,
  OptimizePriority,
  OptimizeTarget,
} from './types.js';

/** The `source` tag consolidation (#12) stamps on every lesson/decision it writes. */
const CONSOLIDATE_SOURCE = 'consolidate';
/** Default cap on candidates returned from one run. */
const DEFAULT_LIMIT = 20;
/** Managed-section header the engine owns inside a target file. */
export const MANAGED_HEADER = '## Consolidated Memory (managed by abs optimize)';

/** A group of consolidated observations that becomes one candidate. */
interface Cluster {
  kind: 'lesson' | 'decision';
  observations: Observation[];
}

/**
 * Read a file's current content, returning '' when it does not exist. READ-ONLY —
 * the whole point of #18 is to never write here. A read error other than ENOENT
 * (e.g. permission) propagates so the caller does not silently diff against ''.
 */
async function readTargetContent(absPath: string): Promise<string> {
  try {
    return await readFile(absPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Pull the consolidated lessons/decisions from the store, newest first, and split
 * them into a decisions cluster and a lessons cluster. Decisions are prioritised
 * (they shape future behaviour) — reflected in the returned order.
 */
function clusterConsolidated(memory: Memory, project: string): Cluster[] {
  // listObservations has no `source` filter, so filter in code. Newest first so a
  // capped run keeps the most recent durable insights. Scoped to `project` (#135): a
  // store-wide pull mixed OTHER projects' decisions into THIS repo's CLAUDE.md candidate,
  // leaking cross-project (and client) content into a tracked file. Optimize consolidates
  // the current project's memory into the current project's targets — nothing else.
  const all = memory.store
    .listObservations({ project, order: 'desc' })
    .filter((o) => o.source === CONSOLIDATE_SOURCE);

  const decisions = all.filter((o) => o.kind === 'decision');
  const lessons = all.filter((o) => o.kind === 'lesson');

  const clusters: Cluster[] = [];
  if (decisions.length > 0) clusters.push({ kind: 'decision', observations: decisions });
  if (lessons.length > 0) clusters.push({ kind: 'lesson', observations: lessons });
  return clusters;
}

/** A decisions cluster targets CLAUDE.md; a lessons cluster targets auto-memory. */
function targetFor(cluster: Cluster, projectRoot: string, projectsDir: string): OptimizeTarget {
  if (cluster.kind === 'decision') {
    return { kind: 'claude-md', absPath: claudeMdPath(projectRoot) };
  }
  return {
    kind: 'auto-memory',
    absPath: autoMemoryEntryPath(projectRoot, projectsDir, 'consolidated-lessons.md'),
    // The engine only ever writes its own managed `project`-type entry; it never
    // proposes touching a user|feedback entry (the #20 guard enforces this too).
    memoryType: 'project',
  };
}

/** Decisions are high priority (always-loaded instructions); lessons are medium. */
function priorityFor(kind: Cluster['kind']): OptimizePriority {
  return kind === 'decision' ? 'high' : 'medium';
}

/**
 * Build the append block: the managed header (when the target lacks it) followed by
 * one bullet per consolidated insight. Content is emitted verbatim as a bullet —
 * never executed/interpreted — and single-lined so a multi-line malicious payload
 * cannot break the markdown structure.
 */
export function buildAppendBlock(cluster: Cluster, currentContent: string): string {
  const hasHeader = currentContent.includes(MANAGED_HEADER);
  const lines: string[] = [];
  if (!hasHeader) {
    lines.push(MANAGED_HEADER, '');
  }
  for (const obs of cluster.observations) {
    const oneLine = obs.content.replace(/\s+/g, ' ').trim();
    lines.push(`- ${oneLine} _(memory #${obs.id})_`);
  }
  // Leading newline so the block is separated from existing content.
  return `\n${lines.join('\n')}\n`;
}

/** The auto-memory entry's `name` (frontmatter + filename sans extension). */
const CONSOLIDATED_LESSONS_NAME = CONSOLIDATED_LESSONS_FILE.replace(/\.md$/, '');

/**
 * The managed YAML frontmatter prepended to the consolidated-lessons entry when it has
 * none (#140) — a new file or the heal of a legacy frontmatter-less dead-drop. Matches the
 * native Claude Code memory shape (`metadata.node_type: memory` + `type: project`) so the
 * index loader treats it like a hand-written entry; `originSessionId` is omitted (optimize
 * has no session). `parseFrontmatterType` reads `metadata.type` from this, keeping the
 * fail-closed guard working. Ends with a trailing newline.
 */
function buildAutoMemoryFrontmatter(): string {
  return [
    '---',
    `name: ${CONSOLIDATED_LESSONS_NAME}`,
    "description: Lessons abs distilled from this project's sessions (managed by abs optimize).",
    'metadata:',
    '  node_type: memory',
    '  type: project',
    '---',
    '',
  ].join('\n');
}

/**
 * Build the entry write for an auto-memory cluster (#140). When the file already has
 * frontmatter (a re-run), this is a clean bullet APPEND — byte-identical to the pre-#140
 * behavior. When it does not (new file or legacy dead-drop), it is a full-file REPLACE
 * that puts frontmatter at the FRONT (an append-only diff cannot express that). Either
 * way the previewed diff is `current → written bytes`.
 */
function buildEntryWrite(
  cluster: Cluster,
  label: string,
  current: string,
): { proposedText: string; diff: string; contentOp: 'append' | 'replace' } {
  const appendBlock = buildAppendBlock(cluster, current);
  if (hasFrontmatter(current)) {
    return {
      proposedText: appendBlock,
      diff: renderAppendDiff(label, current, appendBlock),
      contentOp: 'append',
    };
  }
  const full = `${buildAutoMemoryFrontmatter()}${current}${appendBlock}`;
  return { proposedText: full, diff: renderFullDiff(label, current, full), contentOp: 'replace' };
}

/**
 * Build the paired `MEMORY.md` index pointer write (#140), or `undefined` when the pointer
 * already exists (idempotent). Read-only here — the applier recomputes additively against a
 * fresh read at apply time; this is the preview.
 */
async function buildIndexWrite(
  projectRoot: string,
  projectsDir: string,
): Promise<IndexWrite | undefined> {
  const absPath = memoryIndexPath(projectRoot, projectsDir);
  const current = await readTargetContent(absPath);
  const { content, changed } = ensureIndexPointer(current);
  if (!changed) return undefined;
  return { absPath, proposedText: content, diff: renderFullDiff(MEMORY_INDEX, current, content) };
}

/** Default rationale (the heuristic spine; an LLM may later replace it). */
function heuristicRationale(cluster: Cluster): string {
  const n = cluster.observations.length;
  const noun = cluster.kind === 'decision' ? 'decision' : 'lesson';
  const plural = n === 1 ? noun : `${noun}s`;
  const where = cluster.kind === 'decision' ? 'project CLAUDE.md' : 'auto-memory';
  return `Promote ${n} consolidated ${plural} into ${where} so they persist as durable, recallable project memory.`;
}

/** Title for a cluster's candidate. */
function titleFor(cluster: Cluster): string {
  return cluster.kind === 'decision'
    ? 'Record consolidated decisions in CLAUDE.md'
    : 'Record consolidated lessons in auto-memory';
}

/**
 * Generate evidence-backed candidate diffs from the consolidated memory. Reads the
 * current target files read-only, renders an append-only unified diff per cluster,
 * and returns candidates highest-priority first. Writes NOTHING. The optional
 * LLM-phrasing pass runs on top of this in `index.ts`.
 */
export async function generateCandidates(
  memory: Memory,
  options: GenerateCandidatesOptions = {},
): Promise<OptimizeCandidate[]> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const projectsDir = options.projectsDir ?? defaultProjectsDir();
  const limit = options.limit ?? DEFAULT_LIMIT;
  // `projectSlug(cwd)` is exactly the label recall resolves a cwd to (resolveRecallProject)
  // and the one ingest stores in `sessions.project` — so this scopes to the SAME project's
  // observations recall would surface, never a sibling project's.
  const project = projectSlug(projectRoot);

  const clusters = clusterConsolidated(memory, project);
  const candidates: OptimizeCandidate[] = [];

  for (const cluster of clusters) {
    const target = targetFor(cluster, projectRoot, projectsDir);
    const current = await readTargetContent(target.absPath);
    const label = labelFor(target);

    // CLAUDE.md (decisions): clean append, no index pointer. auto-memory (lessons): the
    // entry may need frontmatter (replace) and gains a MEMORY.md pointer so it is
    // index-visible (#140).
    let entry: { proposedText: string; diff: string; contentOp: 'append' | 'replace' };
    if (target.kind === 'auto-memory') {
      entry = buildEntryWrite(cluster, label, current);
    } else {
      const block = buildAppendBlock(cluster, current);
      entry = {
        proposedText: block,
        diff: renderAppendDiff(label, current, block),
        contentOp: 'append',
      };
    }
    const indexWrite =
      target.kind === 'auto-memory' ? await buildIndexWrite(projectRoot, projectsDir) : undefined;

    candidates.push({
      id: candidateId(target, cluster, current, entry.proposedText),
      target,
      title: titleFor(cluster),
      rationale: heuristicRationale(cluster),
      diff: entry.diff,
      proposedText: entry.proposedText,
      contentOp: entry.contentOp,
      ...(indexWrite ? { indexWrite } : {}),
      // Capture the exact content the diff was generated against so the applier can
      // refuse (`target-modified`) if the file changed since — the #20 TOCTOU guard.
      baseContent: current,
      evidenceIds: cluster.observations.map((o) => o.id),
      priority: priorityFor(cluster.kind),
    });
  }

  // High priority first (decisions before lessons), then stable by id.
  const rank: Record<OptimizePriority, number> = { high: 0, medium: 1, low: 2 };
  candidates.sort((a, b) => rank[a.priority] - rank[b.priority]);
  return candidates.slice(0, limit);
}

/**
 * Content-addressed candidate id (#135 / F3-06): a hash of the WHOLE proposal — target
 * (kind + path), the exact evidence ids, AND the rendered content (base + proposed text) —
 * NOT a positional `cand-N` counter. Positional ids recycle across runs, so `apply cand-2`
 * could bind to a DIFFERENT candidate than the one previewed when the set shifted. Hashing
 * the proposal makes the id stable for an identical diff and CHANGE whenever ANYTHING that
 * alters the diff changes — including the target file mutating between runs under unchanged
 * evidence — so a stale `apply <id>` misses the cache (safe) instead of applying a diff the
 * user never reviewed. (Non-cryptographic id digest; sha256 to avoid the sha1 lint.)
 */
function candidateId(
  target: OptimizeTarget,
  cluster: Cluster,
  baseContent: string,
  proposedText: string,
): string {
  const evidence = cluster.observations.map((o) => o.id).join(',');
  const digest = createHash('sha256')
    .update(`${target.kind}:${target.absPath}:${evidence}:${baseContent}:${proposedText}`)
    .digest('hex')
    .slice(0, 12);
  return `cand-${digest}`;
}

/** Diff label = the file basename, kept short and stable for review. */
function labelFor(target: OptimizeTarget): string {
  return target.kind === 'claude-md' ? 'CLAUDE.md' : 'auto-memory/consolidated-lessons.md';
}

/** Default Claude Code projects root; mirrors the ingest layer's resolver. */
function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}
