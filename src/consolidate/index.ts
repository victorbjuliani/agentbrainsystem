/**
 * Consolidation public surface (issue #12).
 *
 * Distill a session's transcript into durable lessons/decisions via an LLM and
 * write them back as recallable observations. The CLI builds the real provider;
 * tests inject a stub into `consolidate`.
 */
export { consolidate } from './consolidate.js';
export { buildPrompt, estimatePromptTokens, parseLessons } from './distill.js';
export type {
  ConsolidateEstimate,
  ConsolidateOptions,
  ConsolidateResult,
  ConsolidateSkip,
  LessonCandidate,
} from './types.js';
