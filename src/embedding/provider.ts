/**
 * The embedding provider contract shared by every backend (local + hosted).
 *
 * A provider turns text into L2-normalized vectors of a fixed, declared width.
 * The store and index are sized for `dimensions`; the dimension guard
 * (`./guard.ts`) enforces that contract on every batch a provider emits.
 */
export interface EmbeddingProvider {
  /** Stable identifier of the backend, e.g. `'local'`, `'gemini'`, `'voyage'`. */
  readonly id: string;
  /** Concrete model id used by the backend. */
  readonly model: string;
  /** Vector width every `embed` result is guaranteed to have. */
  readonly dimensions: number;
  /**
   * Embed a batch of texts into L2-normalized vectors, one per input, in order.
   * Each returned vector has length === `dimensions` (enforced by the guard).
   */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Optionally warm the backend (e.g. load a local model) up front, bounded by
   * `budgetMs`. Backends with no load cost (hosted APIs) may omit it. The local
   * backend rejects with `EmbeddingLoadTimeoutError` when a budgeted first-run
   * download exceeds the budget, so a hook can fail open instead of hanging (#111).
   */
  ensureReady?(opts?: { budgetMs?: number }): Promise<void>;
}
