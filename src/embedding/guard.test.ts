import { describe, expect, it } from 'vitest';
import { assertDimensions, DimensionMismatchError } from './guard.js';
import type { EmbeddingProvider } from './provider.js';

/** A fake provider whose declared width disagrees with what it actually emits. */
class WrongWidthProvider implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-model';
  readonly dimensions = 384;
  async embed(texts: string[]): Promise<number[][]> {
    // Emits 3-dim vectors despite declaring 384 — must be caught by the guard.
    const vectors = texts.map(() => [0.1, 0.2, 0.3]);
    return assertDimensions(vectors, this.dimensions);
  }
}

class CorrectWidthProvider implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-model';
  readonly dimensions = 3;
  async embed(texts: string[]): Promise<number[][]> {
    const vectors = texts.map(() => [0.1, 0.2, 0.3]);
    return assertDimensions(vectors, this.dimensions);
  }
}

describe('assertDimensions', () => {
  it('passes when every vector matches the expected width', () => {
    const vecs = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(assertDimensions(vecs, 3)).toBe(vecs);
  });

  it('throws DimensionMismatchError on a wrong-width vector', () => {
    expect(() => assertDimensions([[1, 2, 3]], 4)).toThrow(DimensionMismatchError);
  });

  it('reports expected, actual, and index on the error', () => {
    try {
      assertDimensions(
        [
          [1, 2, 3],
          [4, 5],
        ],
        3,
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DimensionMismatchError);
      const e = err as DimensionMismatchError;
      expect(e.expected).toBe(3);
      expect(e.actual).toBe(2);
      expect(e.index).toBe(1);
    }
  });

  it('rejects a non-positive expected dimension', () => {
    expect(() => assertDimensions([[1]], 0)).toThrow(TypeError);
  });
});

describe('dimension guard via provider (no network)', () => {
  it('a provider emitting wrong-width vectors throws', async () => {
    const provider = new WrongWidthProvider();
    await expect(provider.embed(['hello'])).rejects.toThrow(DimensionMismatchError);
  });

  it('a provider emitting correct-width vectors passes', async () => {
    const provider = new CorrectWidthProvider();
    const out = await provider.embed(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(3);
  });
});
