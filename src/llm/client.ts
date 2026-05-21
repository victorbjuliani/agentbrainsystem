/**
 * OpenAI-compatible chat-completions client (issue #12).
 *
 * A thin, dependency-free `fetch` client — same shape as the hosted embedding
 * providers (`src/embedding/hosted.ts`): build a request, run it through
 * `fetchWithRetry` for transient resilience, throw the backend's status on a
 * non-ok response, and parse the well-known OpenAI-compatible response shape.
 *
 * Targets any `/v1`-style endpoint: a local Ollama (`http://localhost:11434/v1`,
 * no API key) or a hosted OpenAI-compatible backend (Bearer key). The per-request
 * timeout is enforced via an `AbortSignal`, and the retry layer's abort-fix means a
 * timeout actually *stops* the request instead of being retried.
 */
import { fetchWithRetry } from '../embedding/retry.js';
import type {
  LlmCompleteOptions,
  LlmCompletion,
  LlmConfig,
  LlmMessage,
  LlmProvider,
} from './types.js';

/** Minimal view of the OpenAI-compatible chat-completions response we rely on. */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Build the AbortSignal for one request: the provider's own timeout, optionally
 * combined with a caller-supplied signal so either source can cancel the request.
 */
function buildSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;
}

export class OpenAiCompatLlmProvider implements LlmProvider {
  readonly id = 'openai-compat';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(config: LlmConfig) {
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
  }

  async complete(messages: LlmMessage[], opts: LlmCompleteOptions = {}): Promise<LlmCompletion> {
    const url = `${this.baseUrl}/chat/completions`;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Only attach the Bearer header when a key is configured — local Ollama needs none.
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const body = {
      model: this.model,
      messages,
      temperature: opts.temperature,
      response_format: opts.responseFormatJson ? { type: 'json_object' } : undefined,
    };

    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // The retry layer's abort-fix makes a timeout/cancellation stop, not retry.
      signal: buildSignal(this.timeoutMs, opts.signal),
    });

    if (!res.ok) {
      // Mirror hosted.ts: surface the status + body, but never headers/api key.
      throw new Error(`llm request failed: ${res.status} ${await res.text()}`);
    }

    const json = (await res.json()) as ChatCompletionResponse;
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('llm response missing choices[0].message.content');
    }

    const completion: LlmCompletion = { text: content };
    if (json.usage) {
      completion.usage = {
        promptTokens: json.usage.prompt_tokens,
        completionTokens: json.usage.completion_tokens,
      };
    }
    return completion;
  }
}
