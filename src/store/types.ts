/**
 * Public types for the memory store (issue #3).
 *
 * Domain shapes use camelCase; the SQLite layer maps them to/from snake_case
 * columns internally. JSON columns (`meta`, `metadata`) round-trip as plain
 * objects.
 */

/** Construction options for a `MemoryStore`. `dimensions` sizes the vec0 column. */
export interface StoreOptions {
  /** Absolute path to the `.db` file, or `:memory:` for an ephemeral store. */
  dbPath: string;
  /** Embedding dimension — must equal `config.embedding.dimensions`. */
  dimensions: number;
}

/** A conversation/run grouping observations together. */
export interface Session {
  id: number;
  /** Stable id from the source harness (unique). */
  externalId: string;
  project?: string;
  startedAt?: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

/** Fields accepted when creating a session. */
export interface CreateSessionInput {
  externalId: string;
  project?: string;
  startedAt?: string;
  /** Defaults to now (ISO) when omitted. */
  createdAt?: string;
  meta?: Record<string, unknown>;
}

/** A single recorded memory item. Its integer `id` keys the vector + FTS tables. */
export interface Observation {
  id: number;
  sessionId: number;
  /** e.g. user / assistant / tool / decision / lesson. */
  kind: string;
  content: string;
  metadata?: Record<string, unknown>;
  source?: string;
  createdAt: string;
}

/** Fields accepted when creating an observation. */
export interface CreateObservationInput {
  sessionId: number;
  kind: string;
  content: string;
  metadata?: Record<string, unknown>;
  source?: string;
  /** Defaults to now (ISO) when omitted. */
  createdAt?: string;
}

/** Filters for listing/iterating observations. */
export interface ListObservationsOptions {
  sessionId?: number;
  kind?: string;
  limit?: number;
}

/**
 * A ranked index hit: the observation `id` plus a score. For `knn` this is the
 * vector distance (lower = closer); for `searchFts` it is the FTS5 `rank`
 * (more negative = better). The recall layer (#6) fuses these via RRF.
 */
export interface KnnHit {
  id: number;
  distance: number;
}

/** Real row counts across the relational + index tables. */
export interface CountsResult {
  sessions: number;
  observations: number;
  vectors: number;
  fts: number;
}
