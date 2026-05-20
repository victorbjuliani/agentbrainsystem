import { describe, expect, it } from 'vitest';
import { LocalEmbeddingProvider } from './local.js';

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
