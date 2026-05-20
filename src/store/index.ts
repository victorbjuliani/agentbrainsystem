/**
 * Store module public surface — the durable persistence layer (issue #3).
 *
 * Re-exports `MemoryStore`, its types, and the schema version constant so
 * downstream layers (embedding #4, indexer #5, recall #6) import from one path.
 */
export { MemoryStore } from './memory-store.js';
export type { Migration } from './schema.js';
export { CURRENT_SCHEMA_VERSION } from './schema.js';
export type {
  CountsResult,
  CreateObservationInput,
  CreateSessionInput,
  KnnHit,
  ListObservationsOptions,
  Observation,
  Session,
  StoreOptions,
} from './types.js';
