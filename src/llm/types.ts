/**
 * LLM provider contract (issue #12).
 *
 * The consolidation feature talks to an OpenAI-compatible chat-completions endpoint
 * (a local Ollama on `/v1`, or any hosted OpenAI-compatible backend). This module
 * defines the *contract* only — no imports — so it can be referenced from both the
 * client implementation and `config.ts` without risking an import cycle.
 *
 * Lane B (the consolidation logic) codes against `LlmProvider` / `LlmCompletion` /
 * `LlmMessage`; this is the frozen interface both lanes share.
 */

/** A single chat-completion message. Only system/user roles are produced by us. */
export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

/** Token usage as reported by the backend (best-effort; may be absent). */
export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
}

/** The result of a completion: the assistant text plus optional usage. */
export interface LlmCompletion {
  text: string;
  usage?: LlmUsage;
}

/** Per-call options for a completion. */
export interface LlmCompleteOptions {
  /** Sampling temperature; passed through to the backend when set. */
  temperature?: number;
  /** Request a JSON object response (`response_format: {type:'json_object'}`). */
  responseFormatJson?: boolean;
  /** Caller cancellation signal; combined with the provider's own timeout. */
  signal?: AbortSignal;
}

/** A pluggable LLM backend. */
export interface LlmProvider {
  /** Stable provider id (e.g. 'openai-compat'). */
  readonly id: string;
  /** Model name in use. */
  readonly model: string;
  complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<LlmCompletion>;
}

/** Runtime configuration for the LLM provider, resolved from env in `config.ts`. */
export interface LlmConfig {
  /** ABS_LLM_BASE_URL — already includes the `/v1` suffix, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  /** ABS_LLM_MODEL — the model name the backend expects. */
  model: string;
  /** ABS_LLM_API_KEY — optional; local backends (Ollama) need none. */
  apiKey?: string;
  /** ABS_LLM_TIMEOUT_MS — per-request timeout; defaults to 60000. */
  timeoutMs: number;
  /** ABS_LLM_PRICE_PER_1K — optional unit price for a cost-estimate line. */
  pricePer1k?: number;
}
