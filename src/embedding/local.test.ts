import { describe, expect, it, vi } from 'vitest';
import { EmbeddingLoadTimeoutError, LocalEmbeddingProvider } from './local.js';

/** Cosine similarity over L2-normalized vectors == dot product. */
function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

describe('LocalEmbeddingProvider', () => {
  // First run downloads the model (~35 s, one-time); cached runs are sub-second.
  // vitest.config sets testTimeout to 60 s to accommodate the cold path.
  it('embeds strings to 384-dim L2-normalized vectors with sane cosine geometry', async () => {
    const provider = new LocalEmbeddingProvider();
    const [a, b] = await provider.embed(['agent memory that survives a restart', 'agent memory']);

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;

    expect(a).toHaveLength(384);
    expect(b).toHaveLength(384);

    // Self-similarity ≈ 1 (normalized).
    expect(dot(a, a)).toBeCloseTo(1, 3);
    // Distinct strings are similar but strictly less than self.
    const cross = dot(a, b);
    expect(cross).toBeLessThan(dot(a, a));
    expect(cross).toBeGreaterThan(0);
  });

  it('returns an empty array for an empty batch without loading the model', async () => {
    const provider = new LocalEmbeddingProvider();
    expect(await provider.embed([])).toEqual([]);
  });
});

/** A trivially-working extractor; load timing is controlled by the deferred promise. */
function fakeExtractor(_texts: string[], _options: { pooling: 'mean'; normalize: boolean }) {
  return Promise.resolve({ tolist: () => [] as number[][] });
}

/** A loader whose resolution we drive by hand, to model a slow first-run download. */
function deferredLoader() {
  let resolve!: (ex: typeof fakeExtractor) => void;
  const pending = new Promise<typeof fakeExtractor>((r) => {
    resolve = r;
  });
  return { load: () => pending, finish: () => resolve(fakeExtractor) };
}

describe('LocalEmbeddingProvider first-run load handling (#111)', () => {
  it('rejects a budgeted ensureReady with EmbeddingLoadTimeoutError, then reuses the same load once it finishes', async () => {
    const { load, finish } = deferredLoader();
    const loadExtractor = vi.fn(load);
    // Unique model id: the extractor memo is keyed by model and shared across the
    // process, so a default-model test would hit the cache the real-embed test warmed.
    // slowLoadAfterMs high so the slow-notice timer never fires inside the tiny budget.
    const provider = new LocalEmbeddingProvider({
      model: 'test-model-timeout',
      loadExtractor,
      slowLoadAfterMs: 10_000,
    });

    await expect(provider.ensureReady({ budgetMs: 20 })).rejects.toBeInstanceOf(
      EmbeddingLoadTimeoutError,
    );
    // The underlying load was NOT cancelled — it is memoized and still in flight.
    expect(loadExtractor).toHaveBeenCalledTimes(1);

    // Download finishes → a later (unbudgeted) call reuses it; no second load.
    finish();
    await expect(provider.ensureReady()).resolves.toBeUndefined();
    expect(loadExtractor).toHaveBeenCalledTimes(1);
  });

  it('fires the first-run notice once when the load is slow', async () => {
    const { load, finish } = deferredLoader();
    const onSlowLoad = vi.fn();
    const provider = new LocalEmbeddingProvider({
      model: 'test-model-slow',
      loadExtractor: load,
      onSlowLoad,
      slowLoadAfterMs: 10,
    });

    const ready = provider.ensureReady();
    await vi.waitFor(() => expect(onSlowLoad).toHaveBeenCalledTimes(1));
    finish();
    await ready;
    // Still exactly once — the notice does not re-fire after the load resolves.
    expect(onSlowLoad).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire the first-run notice when the load is fast', async () => {
    const onSlowLoad = vi.fn();
    const provider = new LocalEmbeddingProvider({
      model: 'test-model-fast',
      loadExtractor: () => Promise.resolve(fakeExtractor),
      onSlowLoad,
      slowLoadAfterMs: 1_000,
    });
    await provider.ensureReady();
    expect(onSlowLoad).not.toHaveBeenCalled();
  });
});
