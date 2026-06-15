/**
 * Store module public surface — the durable persistence layer (issue #3).
 *
 * Re-exports `MemoryStore`, its types, and the schema version constant so
 * downstream layers (embedding #4, indexer #5, recall #6) import from one path.
 */
export {
  acquireCadenceLock,
  CADENCE_HEARTBEAT_MS,
  CADENCE_LOCK_TTL_MS,
  type CadenceLock,
  cadenceLockPath,
} from './cadence-lock.js';
export { CorruptStoreError, MemoryStore, SchemaDowngradeError } from './memory-store.js';
export type { Migration } from './schema.js';
export { CURRENT_SCHEMA_VERSION } from './schema.js';
export type {
  AnchorKind,
  AnchorState,
  CountsResult,
  CreateFactAnchorInput,
  CreateObservationInput,
  CreateSessionInput,
  FactAnchor,
  KnnHit,
  ListObservationsOptions,
  Observation,
  Session,
  StoreOptions,
} from './types.js';
export {
  acquireRebuildLock,
  EMBED_DEGRADED_KEY,
  INGEST_DEFERRED_KEY,
  isRebuildLocked,
  REBUILD_FAILED_KEY,
  REBUILD_HEARTBEAT_MS,
  REBUILD_LOCK_TTL_MS,
  type RebuildLock,
  rebuildLockPath,
} from './write-lock.js';
