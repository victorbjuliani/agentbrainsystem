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

/** The pipeline call signature we depend on (feature-extraction extractor). */
type Extractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/** Memoized pipeline promise — built at most once per process, per model. */
const extractorCache = new Map<string, Promise<Extractor>>();

async function getExtractor(model: string): Promise<Extractor> {
  let pending = extractorCache.get(model);
  if (pending === undefined) {
    // First run downloads & caches the model; afterwards transformers.js reads the
    // local cache. We leave `allowRemoteModels` at its default (true) so the very
    // first ever run can bootstrap the cache; later runs are served offline.
    pending = pipeline('feature-extraction', model) as unknown as Promise<Extractor>;
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
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local';
  readonly model: string;
  readonly dimensions: number;

  constructor(options: LocalProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    if (options.allowRemoteModels !== undefined) {
      env.allowRemoteModels = options.allowRemoteModels;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await getExtractor(this.model);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const result = await extractor(batch, { pooling: 'mean', normalize: true });
      for (const vec of result.tolist()) out.push(vec);
    }
    return assertDimensions(out, this.dimensions);
  }
}
