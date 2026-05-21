import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatLlmProvider } from './client.js';
import type { LlmConfig } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response stand-in (status/ok/headers/text/json only). */
function makeResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

/** A well-formed OpenAI-compatible chat-completions payload. */
function chatPayload(
  content: string,
  usage?: { prompt_tokens?: number; completion_tokens?: number },
) {
  return {
    choices: [{ message: { role: 'assistant', content } }],
    ...(usage ? { usage } : {}),
  };
}

function baseConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5',
    timeoutMs: 60000,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('OpenAiCompatLlmProvider', () => {
  it('happy path: parses content and usage', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeResponse(200, chatPayload('hello world', { prompt_tokens: 12, completion_tokens: 7 })),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiCompatLlmProvider(baseConfig());
    const out = await provider.complete([{ role: 'user', content: 'hi' }]);

    expect(out.text).toBe('hello world');
    expect(out.usage).toEqual({ promptTokens: 12, completionTokens: 7 });
    expect(provider.id).toBe('openai-compat');
    expect(provider.model).toBe('qwen2.5');

    // POSTs to ${baseUrl}/chat/completions with the model + messages in the body.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('qwen2.5');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('omits authorization header when apiKey is absent (local Ollama)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, chatPayload('ok')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiCompatLlmProvider(baseConfig());
    await provider.complete([{ role: 'user', content: 'hi' }]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBeUndefined();
  });

  it('includes a Bearer authorization header when apiKey is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, chatPayload('ok')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiCompatLlmProvider(baseConfig({ apiKey: 'sk-secret-123' }));
    await provider.complete([{ role: 'user', content: 'hi' }]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-secret-123');
  });

  it('sets response_format json_object only when responseFormatJson is true', async () => {
    // Fresh response per call: a Response body can only be read once.
    const fetchMock = vi.fn().mockImplementation(() => makeResponse(200, chatPayload('{}')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new OpenAiCompatLlmProvider(baseConfig());

    await provider.complete([{ role: 'user', content: 'hi' }], { responseFormatJson: true });
    let body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });

    await provider.complete([{ role: 'user', content: 'hi' }]);
    body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(body.response_format).toBeUndefined();
  });

  it('throws with the status on a non-ok response, without leaking the api key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(401, 'unauthorized'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiCompatLlmProvider(baseConfig({ apiKey: 'sk-secret-123' }));
    let caught: unknown;
    try {
      await provider.complete([{ role: 'user', content: 'hi' }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/401/);
    expect(message).not.toContain('sk-secret-123');
  });

  it('throws a clear error when choices/content are missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, { choices: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiCompatLlmProvider(baseConfig());
    await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /content|choices/i,
    );
  });

  it('aborts on timeout and does NOT retry 4× (abort-fix integration)', async () => {
    // fetch honours the abort signal: it rejects with an AbortError once the
    // provider's timeout fires. With the retry abort-fix, this must NOT be retried.
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'AbortError';
          reject(err);
        });
        // Never resolve on its own — only the timeout signal ends this.
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiCompatLlmProvider(baseConfig({ timeoutMs: 5 }));
    await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/abort/i);

    // The timeout aborted the request; the retry loop must have stopped, not spun 4×.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('combines the caller signal with the timeout (caller abort stops the request)', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted by caller');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiCompatLlmProvider(baseConfig({ timeoutMs: 60000 }));
    const controller = new AbortController();
    const promise = provider.complete([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow(/abort/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
