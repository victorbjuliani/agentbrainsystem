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
 *   - Render an append-only unified diff against the current target content.
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
import { renderAppendDiff } from './diff.js';
import { autoMemoryEntryPath, claudeMdPath, projectSlug } from './targets.js';
import type {
  GenerateCandidatesOptions,
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
    const proposedText = buildAppendBlock(cluster, current);
    const diff = renderAppendDiff(labelFor(target), current, proposedText);
    candidates.push({
      id: candidateId(target, cluster, current, proposedText),
      target,
      title: titleFor(cluster),
      rationale: heuristicRationale(cluster),
      diff,
      proposedText,
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
