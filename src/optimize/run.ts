/**
 * Converge orchestration (#21) — the ONE core both `abs optimize` (CLI) and the
 * MCP `optimize`/`apply` tools drive, so the engine (#18) and gated-apply (#20)
 * reach the user through a single code path.
 *
 * Two responsibilities the surfaces share:
 *   - `generateOptimizations` — build the optional LLM provider from config (so
 *     the $0/offline heuristic spine runs when no LLM is set) and produce the
 *     evidence-backed candidate diffs. Read-only.
 *   - `applyApprovedCandidate` — apply ONE already-approved candidate with full
 *     write safety (#20), then advance the staleness cursor (#16) on success so
 *     SessionStart stops nagging once memory has been distilled into the files.
 *
 * Sibling import note: the optimize cursor key builder lives in `hooks/staleness.ts`
 * (its reader, #16). This converge module is the cursor's WRITER (#21/#148); both share
 * the one key builder rather than duplicating the string. Converge logically sits
 * above both siblings, so the single import is intentional, not a layering leak.
 */
import { type AppConfig, loadConfig } from '../config.js';
import { optimizeCursorKey, parseCursor } from '../hooks/staleness.js';
import { createLlmProvider, type LlmProvider } from '../llm/index.js';
import type { Memory } from '../memory.js';
import { type Applier, type ApplyOptions, GatedApplier } from './applier.js';
import { generateCandidates } from './candidate-gen.js';
import { phraseCandidates } from './llm-phrasing.js';
import { projectSlug } from './targets.js';
import type {
  ApplyResult,
  CurationEstimate,
  GenerateCandidatesOptions,
  GenerateCandidatesResult,
  OptimizeCandidate,
  OptimizeEstimate,
} from './types.js';

/**
 * Generate prioritized, evidence-backed candidate diffs from the consolidated
 * memory. The heuristic spine always runs ($0/offline); when `llm` is provided it
 * both (a) runs the curation judge during generation (#146) to drop trivia and
 * (b) phrases the title/rationale only (never the diff/evidence/target). Writes
 * NOTHING — the result is diffs the caller presents for approval.
 */
export async function optimize(
  memory: Memory,
  llm?: LlmProvider,
  options: GenerateCandidatesOptions = {},
): Promise<GenerateCandidatesResult> {
  // Thread the LLM into generation so the curation judge (#146) runs over the
  // consolidated set BEFORE bullets are built. Heuristic curation runs regardless.
  const {
    candidates: curated,
    curation,
    survivingIds,
  } = await generateCandidates(memory, {
    ...options,
    ...(llm ? { llm } : {}),
  });
  const { candidates, estimate: phrasing } = await phraseCandidates(
    curated,
    llm,
    options.pricePer1k,
  );
  // `survivingIds` passes straight through — phrasing only touches title/rationale,
  // never evidence, so the un-sliced keep-set is unchanged by it (#138).
  return {
    candidates,
    estimate: mergeEstimates(phrasing, curation, options.pricePer1k),
    survivingIds,
  };
}

/**
 * Fold the curation-judge estimate and the phrasing estimate into one run estimate
 * (#146). CRITICAL: `phraseCandidates` reports `llmUsed:false`/$0 when its candidate
 * set is empty (`llm-phrasing.ts`) — so when the judge ran (billable) and dropped
 * EVERY candidate, phrasing sees `[]` and would mask a paid run as free. The OR-merge
 * on `llmUsed` and the summed usage make the reported cost truthful. Cost is recomputed
 * ONCE from the summed usage (never summed from pre-rounded per-pass costs).
 */
function mergeEstimates(
  phrasing: OptimizeEstimate,
  curation: CurationEstimate,
  pricePer1k?: number,
): OptimizeEstimate {
  const promptTokens = (phrasing.usage?.promptTokens ?? 0) + (curation.usage?.promptTokens ?? 0);
  const completionTokens =
    (phrasing.usage?.completionTokens ?? 0) + (curation.usage?.completionTokens ?? 0);
  const anyUsage = phrasing.usage !== undefined || curation.usage !== undefined;

  const merged: OptimizeEstimate = {
    promptCharEstimateTokens:
      phrasing.promptCharEstimateTokens + (curation.promptCharEstimateTokens ?? 0),
    llmUsed: phrasing.llmUsed || curation.judgeUsed,
    curation: {
      keptCount: curation.keptCount,
      droppedCount: curation.droppedCount,
      judgeUsed: curation.judgeUsed,
    },
  };
  if (anyUsage) merged.usage = { promptTokens, completionTokens };
  if (pricePer1k !== undefined && anyUsage) {
    merged.costEstimate = ((promptTokens + completionTokens) / 1000) * pricePer1k;
  }
  return merged;
}

/** The shared applier instance (stateless — safe to reuse). */
const applier: Applier = new GatedApplier();

/**
 * Apply ONE already-approved candidate with full write safety (allowlist +
 * fail-closed guard + backup + atomic write + rollback). The interactive approval
 * is the caller's responsibility; this contract is "apply one approved candidate".
 */
export function applyCandidate(
  candidate: OptimizeCandidate,
  options: ApplyOptions,
): Promise<ApplyResult> {
  return applier.apply(candidate, options);
}

/**
 * Generate candidate diffs through the shared engine. The LLM is built from
 * `config.llm` only when configured — otherwise the heuristic spine runs $0/offline
 * (same opt-in contract as consolidation #12). Writes nothing.
 */
export async function generateOptimizations(
  memory: Memory,
  config: AppConfig = loadConfig(),
  options: GenerateCandidatesOptions = {},
): Promise<GenerateCandidatesResult> {
  // createLlmProvider throws when llm is unset; here it's optional, so only build
  // a provider when configured and let the engine fall back to the heuristic.
  const llm = config.llm ? createLlmProvider(config.llm) : undefined;
  const pricePer1k = config.llm?.pricePer1k;
  return optimize(memory, llm, {
    ...options,
    ...(pricePer1k !== undefined ? { pricePer1k } : {}),
  });
}

/**
 * Apply ONE approved candidate with the gated applier's full safety (allowlist +
 * fail-closed user|feedback guard + backup + atomic write + rollback). The cursor
 * advance is NO LONGER its job (#138/#148): the per-kind/project advance is explicit
 * at the run level (`advanceOptimizeCursorsAfterApply`), driven by the curation
 * keep-set — because the all-curated-out path never reaches apply, and a per-kind
 * advance cannot be derived from a single per-write side-effect.
 */
export async function applyApprovedCandidate(
  memory: Memory,
  candidate: OptimizeCandidate,
  options: ApplyOptions,
): Promise<ApplyResult> {
  // Wire the stale-content (TOCTOU) guard: re-verify the file still matches what the
  // diff was generated against. The candidate captured that content at generation
  // (#18); pass it as `expectedBaseContent` unless the caller already pinned one.
  const guarded: ApplyOptions =
    options.expectedBaseContent === undefined
      ? { ...options, expectedBaseContent: candidate.baseContent }
      : options;
  return applyCandidate(candidate, guarded);
}

/** Map a candidate's target kind to its optimize-cursor obs kind (#138). */
function cursorKindForTarget(candidate: OptimizeCandidate): 'lesson' | 'decision' {
  // auto-memory ⇐ lessons (cadence auto-promotes); claude-md ⇐ decisions (manual).
  return candidate.target.kind === 'auto-memory' ? 'lesson' : 'decision';
}

/** The four-set partition of `S_kind` (#138/#148 §4 KEEP-SET model). */
export interface ConsolidatedPartition {
  /** `keep ∩ S_kind` — survived curation (authoritative, slice-independent). */
  survivors: Set<number>;
  /** `S_kind − survivors` — dropped by the heuristic/judge, never promotable. */
  curatedOut: Set<number>;
  /** `∪ evidenceIds(applied candidates of this kind)`. */
  promoted: Set<number>;
  /** `survivors − promoted` — survived curation but not yet promoted (includes a
   * declined candidate, a bare preview, a cadence-skipped decision, AND a
   * `--limit`-sliced survivor). Cursor advances IFF this is empty. */
  pendingValid: Set<number>;
}

/**
 * Partition one kind's `S_kind` (consolidate-obs ids above the cursor) against the
 * curation KEEP-SET (#138/#148 §4). The keep-set — NOT the post-slice candidate
 * list — is the source of truth, so a `--limit`-sliced survivor (in `keep`, absent
 * from any candidate's `evidenceIds`) lands in `pendingValid`, never `curatedOut`.
 * Pure.
 */
export function partitionConsolidated(
  sKind: number[],
  keep: Set<number>,
  candidatesOfKind: OptimizeCandidate[],
  appliedIds: Set<string>,
): ConsolidatedPartition {
  const sSet = new Set(sKind);
  const survivors = new Set<number>();
  for (const id of sSet) if (keep.has(id)) survivors.add(id);
  const curatedOut = new Set<number>();
  for (const id of sSet) if (!survivors.has(id)) curatedOut.add(id);
  const promoted = new Set<number>();
  for (const c of candidatesOfKind) {
    if (!appliedIds.has(c.id)) continue;
    for (const eid of c.evidenceIds) if (sSet.has(eid)) promoted.add(eid);
  }
  const pendingValid = new Set<number>();
  for (const id of survivors) if (!promoted.has(id)) pendingValid.add(id);
  return { survivors, curatedOut, promoted, pendingValid };
}

/**
 * Advance ONE kind's project-scoped optimize cursor IFF every surviving obs of that
 * kind was promoted (#138/#148 §4). No-op when `S_kind` is empty. The advance target
 * is `maxConsolidatedId(project, kind)` — never a higher raw-turn id, never another
 * project's id. A sliced-off survivor keeps the cursor pinned (pending-valid).
 */
export function advanceOptimizeCursorForKind(
  memory: Memory,
  kind: 'lesson' | 'decision',
  projectSlugValue: string,
  keep: Set<number>,
  candidatesOfKind: OptimizeCandidate[],
  appliedIds: Set<string>,
): void {
  const key = optimizeCursorKey(kind, projectSlugValue);
  const cursor = parseCursor(memory.store.getMeta(key));
  const sKind = memory.store.consolidatedIdsSince(projectSlugValue, kind, cursor);
  if (sKind.length === 0) return; // nothing reviewed for this kind/project
  const { pendingValid } = partitionConsolidated(sKind, keep, candidatesOfKind, appliedIds);
  if (pendingValid.size === 0) {
    memory.store.setMeta(key, String(memory.store.maxConsolidatedId(projectSlugValue, kind)));
  }
}

/**
 * Run-level cursor advance after the apply loop (#138/#148): advance each kind's
 * project-scoped cursor per the §4 keep-set partition. Both the cadence runner
 * (Phase 4) and manual `cmdOptimize` (Phase 5) call THIS, passing the SAME run-wide
 * `keep` set (the kind-agnostic survivingIds; the per-kind `S_kind ∩` scopes it).
 */
export function advanceOptimizeCursorsAfterApply(
  memory: Memory,
  projectSlugValue: string,
  keep: Set<number>,
  candidates: OptimizeCandidate[],
  appliedIds: Set<string>,
): void {
  for (const kind of ['lesson', 'decision'] as const) {
    const ofKind = candidates.filter((c) => cursorKindForTarget(c) === kind);
    advanceOptimizeCursorForKind(memory, kind, projectSlugValue, keep, ofKind, appliedIds);
  }
}

/** Re-export so callers compute the same slug the cursor keys use (#138). */
export { projectSlug };
