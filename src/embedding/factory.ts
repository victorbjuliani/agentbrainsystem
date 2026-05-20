/**
 * Embedding provider factory — maps the active config to a concrete provider.
 *
 * `'local'` returns the default transformers.js backend; `'gemini'` / `'voyage'` return
 * the hosted clients (which throw on construction if their API key env var is missing).
 * The factory threads `config.embedding.dimensions` into every provider so the declared
 * width follows the shared contract in `src/config.ts`.
 */
import type { EmbeddingConfig } from '../config.js';
import { GeminiEmbeddingProvider, VoyageEmbeddingProvider } from './hosted.js';
import { LocalEmbeddingProvider } from './local.js';
import type { EmbeddingProvider } from './provider.js';

/**
 * Build the embedding provider for the given config. The `model` field is passed
 * through when set, and `dimensions` is always honored so the store/index stay aligned.
 *
 * @throws Error for an unknown provider id, or when a hosted provider is selected
 *   without its required API key env var.
 */
export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  const model = config.model.trim() === '' ? undefined : config.model;
  switch (config.provider) {
    case 'local':
      return new LocalEmbeddingProvider({ model, dimensions: config.dimensions });
    case 'gemini':
      return new GeminiEmbeddingProvider({ model, dimensions: config.dimensions });
    case 'voyage':
      return new VoyageEmbeddingProvider({ model, dimensions: config.dimensions });
    default: {
      const unknown: string = config.provider;
      throw new Error(`unknown embedding provider '${unknown}'`);
    }
  }
}
