import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiEmbeddingProvider, VoyageEmbeddingProvider } from './hosted.js';
import { fetchWithRetry } from './retry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response stand-in. We only use status/ok/headers/text/json. */
function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

/** A no-op sleep that records each requested delay so tests can assert backoff. */
function recordingSleep(): { fn: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    fn: async (ms: number) => {
      delays.push(ms);
    },
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// fetchWithRetry — direct unit tests
// ---------------------------------------------------------------------------

describe('fetchWithRetry', () => {
  it('retries on 503 then returns the eventual 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503, 'down'))
      .mockResolvedValueOnce(makeResponse(503, 'down'))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = recordingSleep();

    const res = await fetchWithRetry(
      'https://example.test',
      { method: 'POST' },
      { sleep: sleep.fn, random: () => 1 },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.delays).toHaveLength(2);
  });

  it('retries on 429 then returns the eventual 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429, 'slow down'))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = recordingSleep();

    const res = await fetchWithRetry(
      'https://example.test',
      {},
      { sleep: sleep.fn, random: () => 1 },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors a numeric Retry-After header (delta-seconds), clamped to maxDelayMs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429, 'slow', { 'retry-after': '1' }))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = recordingSleep();

    await fetchWithRetry('https://example.test', {}, { sleep: sleep.fn, random: () => 0 });

    // Retry-After wins over jitter: ~1000ms even though random()=0.
    expect(sleep.delays).toEqual([1000]);
  });

  it('honors an HTTP-date Retry-After header', async () => {
    const future = new Date(Date.now() + 2000).toUTCString();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503, 'down', { 'retry-after': future }))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = recordingSleep();

    await fetchWithRetry('https://example.test', {}, { sleep: sleep.fn, random: () => 0 });

    expect(sleep.delays).toHaveLength(1);
    // Roughly 2s in the future; allow scheduling slack.
    expect(sleep.delays[0]).toBeGreaterThan(500);
    expect(sleep.delays[0]).toBeLessThanOrEqual(2000);
  });

  it('returns the last retryable response after exhausting attempts (no throw)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(503, 'down'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = recordingSleep();

    const res = await fetchWithRetry(
      'https://example.test',
      {},
      { maxAttempts: 4, sleep: sleep.fn, random: () => 1 },
    );

    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // One sleep per retry (3 retries for 4 attempts).
    expect(sleep.delays).toHaveLength(3);
  });

  it('does NOT retry a non-retryable status (400)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(400, 'bad request'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = recordingSleep();

    const res = await fetchWithRetry('https://example.test', {}, { sleep: sleep.fn });

    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep.delays).toHaveLength(0);
  });

  it('retries on a network throw then resolves', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = recordingSleep();

    const res = await fetchWithRetry(
      'https://example.test',
      {},
      { sleep: sleep.fn, random: () => 1 },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep.delays).toHaveLength(1);
  });

  it('rethrows the last error after exhausting attempts on persistent network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ENETUNREACH'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = recordingSleep();

    await expect(
      fetchWithRetry(
        'https://example.test',
        {},
        { maxAttempts: 3, sleep: sleep.fn, random: () => 1 },
      ),
    ).rejects.toThrow(/ENETUNREACH/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('full jitter: random()=1 yields the full computed exp backoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503, 'down'))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = recordingSleep();

    await fetchWithRetry(
      'https://example.test',
      {},
      { baseDelayMs: 250, sleep: sleep.fn, random: () => 1 },
    );

    // attempt 1 -> baseDelayMs * 2^0 = 250, full jitter w/ random()=1 -> 250.
    expect(sleep.delays).toEqual([250]);
  });

  it('full jitter: random()=0 yields a zero delay', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503, 'down'))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = recordingSleep();

    await fetchWithRetry(
      'https://example.test',
      {},
      { baseDelayMs: 250, sleep: sleep.fn, random: () => 0 },
    );

    expect(sleep.delays).toEqual([0]);
  });

  it.each([
    500, 502, 504,
  ])('does NOT retry status %i (retryable set is exactly {429,503})', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(status, 'server error'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = recordingSleep();

    const res = await fetchWithRetry('https://example.test', {}, { sleep: sleep.fn });

    expect(res.status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep.delays).toHaveLength(0);
  });

  it('falls back to jitter backoff when Retry-After is malformed (never a NaN delay)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503, 'down', { 'retry-after': 'not-a-number' }))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = recordingSleep();

    await fetchWithRetry(
      'https://example.test',
      {},
      { baseDelayMs: 250, sleep: sleep.fn, random: () => 1 },
    );

    // Malformed Retry-After is ignored → exp backoff with random()=1 → 250 (not NaN).
    expect(sleep.delays).toEqual([250]);
  });
});

// ---------------------------------------------------------------------------
// Provider end-to-end (Voyage + Gemini) — retry wired through embed()
// ---------------------------------------------------------------------------

describe('GeminiEmbeddingProvider retry integration', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  function geminiPayload(dim: number): unknown {
    // A single non-normalized vector so we can confirm normalization runs.
    const values = Array.from({ length: dim }, (_, i) => (i === 0 ? 3 : 0));
    return { embeddings: [{ values }] };
  }

  it('retries on 503 twice then resolves with normalized vectors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503, 'down'))
      .mockResolvedValueOnce(makeResponse(503, 'down'))
      .mockResolvedValueOnce(makeResponse(200, geminiPayload(768)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new GeminiEmbeddingProvider({
      retry: { sleep: async () => {}, random: () => 1 },
    });
    const vectors = await provider.embed(['hello']);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(768);
    // L2-normalized: a single non-zero component becomes 1.
    expect(vectors[0]?.[0]).toBeCloseTo(1);
  });
});

describe('VoyageEmbeddingProvider retry integration', () => {
  beforeEach(() => {
    process.env.VOYAGE_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete process.env.VOYAGE_API_KEY;
  });

  function voyagePayload(dim: number): unknown {
    const embedding = Array.from({ length: dim }, (_, i) => (i === 0 ? 5 : 0));
    return { data: [{ embedding }] };
  }

  it('retries on 429 then resolves with correct vectors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429, 'slow down'))
      .mockResolvedValueOnce(makeResponse(200, voyagePayload(1024)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new VoyageEmbeddingProvider({
      retry: { sleep: async () => {}, random: () => 1 },
    });
    const vectors = await provider.embed(['hello']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(1024);
    expect(vectors[0]?.[0]).toBeCloseTo(1);
  });

  it('throws the usual "request failed: 503" error after exhausting maxAttempts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(503, 'still down'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new VoyageEmbeddingProvider({
      retry: { maxAttempts: 4, sleep: async () => {}, random: () => 1 },
    });

    await expect(provider.embed(['hello'])).rejects.toThrow(
      /voyage embeddings request failed: 503/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry on a 400; throws immediately', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(400, 'bad input'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new VoyageEmbeddingProvider({
      retry: { sleep: async () => {}, random: () => 1 },
    });

    await expect(provider.embed(['hello'])).rejects.toThrow(
      /voyage embeddings request failed: 400/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on a network error then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(makeResponse(200, voyagePayload(1024)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new VoyageEmbeddingProvider({
      retry: { sleep: async () => {}, random: () => 1 },
    });
    const vectors = await provider.embed(['hello']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vectors[0]?.[0]).toBeCloseTo(1);
  });
});
