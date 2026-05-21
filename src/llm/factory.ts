/**
 * LLM provider factory (issue #12).
 *
 * Consolidation is opt-in: with no LLM endpoint configured the system stays at the
 * $0/offline default. So the factory fails loudly with an actionable message when a
 * caller reaches for an LLM provider without one configured, rather than constructing
 * a half-initialised client that errors on first request.
 */
import { OpenAiCompatLlmProvider } from './client.js';
import type { LlmConfig, LlmProvider } from './types.js';

export function createLlmProvider(config: LlmConfig | undefined): LlmProvider {
  if (!config) {
    throw new Error(
      'consolidate requires ABS_LLM_BASE_URL + ABS_LLM_MODEL ' +
        '(e.g. a local Ollama or a hosted OpenAI-compatible endpoint)',
    );
  }
  return new OpenAiCompatLlmProvider(config);
}
