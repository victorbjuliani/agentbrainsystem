/**
 * Dimension guard — the single defense against cross-dimension index corruption.
 *
 * The vector index is a fixed-width `vec0(embedding float[N])` column. Swapping the
 * embedding provider (local 384-dim ↔ Gemini 768-dim ↔ Voyage 1024-dim) MUST never
 * silently write a wrong-width vector into that column. Every provider runs its
 * produced vectors through `assertDimensions` before returning, and the store/indexer
 * (#5) reuses the same guard at write time.
 */

/** Thrown when a vector's width does not match the expected dimension. */
export class DimensionMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;
  /** Index of the offending vector within the batch. */
  readonly index: number;

  constructor(expected: number, actual: number, index: number) {
    super(
      `Embedding dimension mismatch at vector ${index}: expected ${expected}, got ${actual}. ` +
        'Refusing to write a wrong-width vector into the index (cross-provider corruption guard).',
    );
    this.name = 'DimensionMismatchError';
    this.expected = expected;
    this.actual = actual;
    this.index = index;
  }
}

/**
 * Assert that every vector in `vectors` has exactly `expected` length.
 * Throws {@link DimensionMismatchError} on the first offending vector.
 * Returns the same array (typed as `number[][]`) so it can be used inline.
 */
export function assertDimensions(vectors: readonly number[][], expected: number): number[][] {
  if (!Number.isInteger(expected) || expected <= 0) {
    throw new TypeError(`Expected dimension must be a positive integer, got ${expected}.`);
  }
  for (let i = 0; i < vectors.length; i++) {
    const vec = vectors[i];
    if (vec === undefined) {
      throw new DimensionMismatchError(expected, 0, i);
    }
    if (vec.length !== expected) {
      throw new DimensionMismatchError(expected, vec.length, i);
    }
  }
  return vectors as number[][];
}
