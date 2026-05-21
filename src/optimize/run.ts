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
  GenerateCandidatesOptions,
  GenerateCandidatesResult,
  OptimizeCandidate,
} from './types.js';

/**
 * Generate prioritized, evidence-backed candidate diffs from the consolidated
 * memory. The heuristic spine always runs ($0/offline); when `llm` is provided it
 * phrases the title/rationale only (never the diff/evidence/target). Writes
 * NOTHING — the result is diffs the caller presents for approval.
 */
export async function optimize(
  memory: Memory,
  llm?: LlmProvider,
  options: GenerateCandidatesOptions = {},
): Promise<GenerateCandidatesResult> {
  const base = await generateCandidates(memory, options);
  const { candidates, estimate } = await phraseCandidates(base, llm, options.pricePer1k);
  return { candidates, estimate };
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
  const result = await applyCandidate(candidate, options);
  if (result.applied) {
    memory.store.setMeta(OPTIMIZE_CURSOR_KEY, String(memory.store.maxObservationId()));
  }
  return result;
}
