/**
 * Optimize engine public surface (issues #18, #20).
 *
 * The optimize track turns the durable lessons/decisions consolidation (#12) wrote
 * into the store into **evidence-backed candidate diffs** (#18, diffs-only — writes
 * nothing) and applies a single approved candidate with backup/atomic/rollback
 * write safety + a fail-closed user|feedback guard (#20).
 *
 * This is the ONLY module the #21 converge step imports from. It must NOT touch
 * `src/cli/cli.ts` or `src/mcp/server.ts` — converge wires those in separately.
 *
 * Two entry points #21 calls:
 *   - `optimize(memory, llm?, options?)` — generate prioritized candidates
 *     (heuristic spine + optional LLM phrasing). Returns diffs only.
 *   - `applyCandidate(candidate, options)` — apply ONE already-approved candidate.
 */
import type { LlmProvider } from '../llm/index.js';
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

export type {
  Applier,
  ApplierFs,
  ApplyOptions,
} from './applier.js';
export { GatedApplier } from './applier.js';
export { generateCandidates } from './candidate-gen.js';
export {
  autoMemoryDir,
  autoMemoryEntryPath,
  claudeMdPath,
  isProtectedMemoryType,
  parseFrontmatterType,
  projectSlug,
  resolveTarget,
} from './targets.js';
export type {
  ApplyRefusal,
  ApplyResult,
  AutoMemoryType,
  GenerateCandidatesOptions,
  GenerateCandidatesResult,
  OptimizeCandidate,
  OptimizeEstimate,
  OptimizePriority,
  OptimizeTarget,
  OptimizeTargetKind,
} from './types.js';

/**
 * Generate prioritized, evidence-backed candidate diffs from the consolidated
 * memory. The heuristic spine always runs ($0/offline); when `llm` is provided it
 * phrases the title/rationale only (never the diff/evidence/target). Writes
 * NOTHING — the result is diffs the caller (#21) presents for approval.
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
 * is the caller's responsibility (#21); this contract is "apply one approved
 * candidate". Returns whether it applied or was refused (with the refusal reason).
 */
export function applyCandidate(
  candidate: OptimizeCandidate,
  options: ApplyOptions,
): Promise<ApplyResult> {
  return applier.apply(candidate, options);
}
