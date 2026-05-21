/**
 * Optimize engine public surface (issues #18, #20).
 *
 * The optimize track turns the durable lessons/decisions consolidation (#12) wrote
 * into the store into **evidence-backed candidate diffs** (#18, diffs-only — writes
 * nothing). The gated applier (#20) extends this surface with `applyCandidate`.
 *
 * This is the ONLY module the #21 converge step imports from. It must NOT touch
 * `src/cli/cli.ts` or `src/mcp/server.ts` — converge wires those in separately.
 */
import type { LlmProvider } from '../llm/index.js';
import type { Memory } from '../memory.js';
import { generateCandidates } from './candidate-gen.js';
import { phraseCandidates } from './llm-phrasing.js';
import type { GenerateCandidatesOptions, GenerateCandidatesResult } from './types.js';

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
