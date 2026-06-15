/**
 * Optimize engine public surface (issues #18, #20).
 *
 * The optimize track turns the durable lessons/decisions consolidation (#12) wrote
 * into the store into **evidence-backed candidate diffs** (#18, diffs-only — writes
 * nothing) and applies a single approved candidate with backup/atomic/rollback
 * write safety + a fail-closed user|feedback guard (#20).
 *
 * Barrel for the optimize track. The orchestration entry points live in `run.js`
 * (the converge core both the CLI and MCP drive):
 *   - `optimize(memory, llm?, options?)` — generate prioritized candidates
 *     (heuristic spine + optional LLM phrasing). Returns diffs only.
 *   - `applyCandidate(candidate, options)` — apply ONE already-approved candidate.
 *   - `generateOptimizations` / `applyApprovedCandidate` — config-aware wrappers
 *     that build the LLM from config and advance the staleness cursor (#16) on a
 *     successful apply.
 */
export type {
  Applier,
  ApplierFs,
  ApplyOptions,
} from './applier.js';
export { GatedApplier } from './applier.js';
export { generateCandidates } from './candidate-gen.js';
export { curateObservations, scoreDurability } from './curate.js';
export { judgeObservations } from './llm-judge.js';
export {
  applyApprovedCandidate,
  applyCandidate,
  generateOptimizations,
  optimize,
} from './run.js';
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
  CurationEstimate,
  CurationResult,
  CurationVerdict,
  GenerateCandidatesOptions,
  GenerateCandidatesResult,
  OptimizeCandidate,
  OptimizeEstimate,
  OptimizePriority,
  OptimizeTarget,
  OptimizeTargetKind,
} from './types.js';
