/**
 * LLM layer public surface (issue #12).
 *
 * The OpenAI-compatible client + factory for consolidation. Lane B codes against the
 * `LlmProvider` / `LlmCompletion` / `LlmMessage` contract re-exported here.
 */
export { OpenAiCompatLlmProvider } from './client.js';
export { createLlmProvider } from './factory.js';
export type {
  LlmCompleteOptions,
  LlmCompletion,
  LlmConfig,
  LlmMessage,
  LlmProvider,
  LlmUsage,
} from './types.js';
