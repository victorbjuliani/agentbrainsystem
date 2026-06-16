/**
 * Local embedding provider — the default, $0, offline-after-first-cache backend.
 *
 * Uses transformers.js (`@huggingface/transformers`) with `Xenova/all-MiniLM-L6-v2`,
 * mean-pooled + L2-normalized → 384-dim vectors. The `feature-extraction` pipeline is
 * expensive to construct, so it is lazy-loaded ONCE and memoized across all calls and
 * provider instances. First run downloads the model (~35 s); subsequent runs read the
 * local cache (~280 ms for a small batch).
 */
import { env, pipeline } from '@huggingface/transformers';
import { assertDimensions } from './guard.js';
import type { EmbeddingProvider } from './provider.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DIMENSIONS = 384;
/** Keep batches modest to stay light on 8 GB machines. */
const MAX_BATCH = 32;
/** A load slower than this is the first-run download → emit the one-time notice (#111). */
const DEFAULT_SLOW_LOAD_AFTER_MS = 2_000;
/** The first-run notice. The download is ~35s; without this the CLI/hook just hangs. */
const FIRST_RUN_NOTICE =
  '[abs] downloading embedding model (~35s, first run only; cached offline afterwards)…';

/** The pipeline call signature we depend on (feature-extraction extractor). */
type Extractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

type ExtractorLoader = (model: string) => Promise<Extractor>;

/**
 * Thrown when a BUDGETED model load (the hook path) exceeds its budget — the caller
 * fails open and records a degraded note instead of silently blowing the hook timeout
 * (#111). The underlying load keeps running (memoized), so a later unbudgeted call
 * (`abs ingest`) reuses it once the download finishes.
 */
export class EmbeddingLoadTimeoutError extends Error {
  constructor(
    readonly model: string,
    readonly budgetMs: number,
  ) {
    super(`embedding model "${model}" did not load within ${budgetMs}ms (first-run download)`);
    this.name = 'EmbeddingLoadTimeoutError';
  }
}

/** Memoized pipeline promise — built at most once per process, per model. */
const extractorCache = new Map<string, Promise<Extractor>>();
/** Emit the first-run notice at most once per process. */
let firstRunNoticeEmitted = false;

function loadExtractorOnce(model: string, loader: ExtractorLoader): Promise<Extractor> {
  let pending = extractorCache.get(model);
  if (pending === undefined) {
    pending = loader(model);
    // F5-06: never memoize a FAILED load forever. A transient model-load failure
    // (download timeout, network blip) would otherwise stay cached as a rejected
    // promise and permanently disable embeddings with no retry. On rejection, evict
    // THIS entry so the next call re-attempts the load. The identity guard avoids
    // deleting a newer (possibly successful) promise that already replaced ours.
    pending.catch(() => {
      if (extractorCache.get(model) === pending) extractorCache.delete(model);
    });
    extractorCache.set(model, pending);
  }
  return pending;
}

export interface LocalProviderOptions {
  /** Override the model id (defaults to all-MiniLM-L6-v2). */
  model?: string;
  /** Expected vector width; defaults to 384 for the default model. */
  dimensions?: number;
  /**
   * When false, transformers.js will not reach the network and serves only from the
   * local cache. Defaults to true so a cold machine can bootstrap the model.
   */
  allowRemoteModels?: boolean;
  /** Test seam: override how the extractor is loaded (defaults to transformers.js). */
  loadExtractor?: ExtractorLoader;
  /** Called once when the first-run load is slow (default: print {@link FIRST_RUN_NOTICE}). */
  onSlowLoad?: () => void;
  /** ms before {@link onSlowLoad} fires (default 2000). */
  slowLoadAfterMs?: number;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local';
  readonly model: string;
  readonly dimensions: number;
  private readonly loader: ExtractorLoader;
  private readonly onSlowLoad: () => void;
  private readonly slowLoadAfterMs: number;

  constructor(options: LocalProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    if (options.allowRemoteModels !== undefined) {
      env.allowRemoteModels = options.allowRemoteModels;
    }
    this.loader =
      options.loadExtractor ??
      ((m) => pipeline('feature-extraction', m) as unknown as Promise<Extractor>);
    this.onSlowLoad =
      options.onSlowLoad ??
      (() => {
        if (firstRunNoticeEmitted) return;
        firstRunNoticeEmitted = true;
        process.stderr.write(`${FIRST_RUN_NOTICE}\n`);
      });
    this.slowLoadAfterMs = options.slowLoadAfterMs ?? DEFAULT_SLOW_LOAD_AFTER_MS;
  }

  /**
   * Load (or reuse) the model, attaching a one-time slow-load notice and, when
   * `budgetMs` is given, a timeout that rejects with {@link EmbeddingLoadTimeoutError}
   * WITHOUT cancelling the underlying load (it stays memoized for a later call).
   */
  private load(budgetMs?: number): Promise<Extractor> {
    const pending = loadExtractorOnce(this.model, this.loader);

    // First-run notice: fire once if the load is still pending after the slow threshold.
    const slowTimer = setTimeout(() => this.onSlowLoad(), this.slowLoadAfterMs);
    slowTimer.unref?.(); // never keep the process alive just for the notice
    pending.then(
      () => clearTimeout(slowTimer),
      () => clearTimeout(slowTimer),
    );

    if (budgetMs === undefined) return pending;

    // Budgeted (hook) path: reject on timeout but let the load keep running.
    return new Promise<Extractor>((resolve, reject) => {
      let settled = false;
      const budgetTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new EmbeddingLoadTimeoutError(this.model, budgetMs));
      }, budgetMs);
      budgetTimer.unref?.();
      pending.then(
        (ex) => {
          if (settled) return;
          settled = true;
          clearTimeout(budgetTimer);
          resolve(ex);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(budgetTimer);
          reject(err);
        },
      );
    });
  }

  /**
   * Warm the model up front, optionally bounded by `budgetMs`. The hook path passes a
   * budget so a first-run download can't blow the 8s hook timeout (#111); the CLI path
   * calls it unbudgeted so the first-run notice prints and the download completes.
   */
  async ensureReady(opts: { budgetMs?: number } = {}): Promise<void> {
    await this.load(opts.budgetMs);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const result = await extractor(batch, { pooling: 'mean', normalize: true });
      for (const vec of result.tolist()) out.push(vec);
    }
    return assertDimensions(out, this.dimensions);
  }
}
