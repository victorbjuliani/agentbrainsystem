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
 * Sibling import note: the staleness cursor key lives in `hooks/staleness.ts`
 * (its reader, #16). This converge module is the cursor's WRITER (#21); both share
 * the one key constant rather than duplicating the string. Converge logically sits
 * above both siblings, so the single import is intentional, not a layering leak.
 */
import { type AppConfig, loadConfig } from '../config.js';
import { OPTIMIZE_CURSOR_KEY } from '../hooks/staleness.js';
import { createLlmProvider, type LlmProvider } from '../llm/index.js';
import type { Memory } from '../memory.js';
import { type Applier, type ApplyOptions, GatedApplier } from './applier.js';
import { generateCandidates } from './candidate-gen.js';
import { phraseCandidates } from './llm-phrasing.js';
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
  const { candidates: curated, curation } = await generateCandidates(memory, {
    ...options,
    ...(llm ? { llm } : {}),
  });
  const { candidates, estimate: phrasing } = await phraseCandidates(
    curated,
    llm,
    options.pricePer1k,
  );
  return { candidates, estimate: mergeEstimates(phrasing, curation, options.pricePer1k) };
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
 * fail-closed user|feedback guard + backup + atomic write + rollback). On a real
 * write, advance the staleness cursor to the current high-water mark so the
 * "N pending" flag (#16) resets — the memory up to now is considered distilled.
 * A refusal (forbidden target / protected entry / target modified) does NOT
 * advance the cursor: nothing was written.
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
  const result = await applyCandidate(candidate, guarded);
  if (result.applied) {
    memory.store.setMeta(OPTIMIZE_CURSOR_KEY, String(memory.store.maxObservationId()));
  }
  return result;
}
