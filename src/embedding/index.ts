/**
 * Embedding layer public surface (issue #4).
 *
 * Local transformers.js is the default; Gemini/Voyage are pluggable via config. The
 * dimension guard is exported so the store/indexer (#5) can guard at write time too.
 */
export { createEmbeddingProvider } from './factory.js';
export { assertDimensions, DimensionMismatchError } from './guard.js';
export type { GeminiProviderOptions, VoyageProviderOptions } from './hosted.js';
export { GeminiEmbeddingProvider, VoyageEmbeddingProvider } from './hosted.js';
export type { LocalProviderOptions } from './local.js';
export { EmbeddingLoadTimeoutError, LocalEmbeddingProvider } from './local.js';
export type { EmbeddingProvider } from './provider.js';
