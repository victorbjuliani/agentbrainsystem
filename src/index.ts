/**
 * agentbrainsystem — public library surface.
 *
 * Local-first persistent memory for AI coding agents. The package re-exports the
 * stable building blocks here as each issue lands (store, embedding, indexer,
 * recall, ingest, export). For now it exposes the version.
 */

export type { AppConfig, EmbeddingConfig, EmbeddingProviderId } from './config.js';
export { DEFAULTS, loadConfig } from './config.js';
export type { EmbeddingProvider } from './embedding/index.js';
export {
  assertDimensions,
  createEmbeddingProvider,
  DimensionMismatchError,
} from './embedding/index.js';
export { exportStore, importStore } from './export/index.js';
export type { EnsureResult, IndexStatus } from './indexer/index.js';
export { Indexer } from './indexer/index.js';
export { ingestClaudeProjects } from './ingest/index.js';
export { type Memory, openMemory } from './memory.js';
export { Recall } from './recall/index.js';
export { MemoryStore } from './store/index.js';
export { VERSION } from './version.js';
