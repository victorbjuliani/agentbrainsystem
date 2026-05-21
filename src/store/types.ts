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
  /**
   * Keyset cursor: return only rows with `id > afterId`. Combined with `order:'asc'`
   * and `limit`, this paginates the table one closed query at a time — used by the
   * indexer rebuild to walk the whole store WITHOUT holding a row cursor open while
   * it writes vectors back to the same connection (#34).
   */
  afterId?: number;
  /**
   * Row order by `id`. Defaults to `'asc'` (oldest first) — the contract every
   * existing caller (ingest, indexer rebuild, export, recall) relies on. Pass
   * `'desc'` to read the NEWEST rows first, e.g. a capped most-recent tail.
   */
  order?: 'asc' | 'desc';
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

/**
 * Verifiability of a fact anchor (the E layer):
 *   - `claimed`: seeded from a tool-call signal, not yet checked against the graph.
 *   - `verified`: resolved against ground-truth; carries `file:line@commit`.
 *   - `stale`: the anchored symbol/file no longer resolves (self-healing marks it).
 */
export type AnchorState = 'claimed' | 'verified' | 'stale';

/** What a fact anchor points at: a specific symbol, or a whole file. */
export type AnchorKind = 'symbol' | 'file';

/** A code-location anchor tying an observation (fact) to ground truth. */
export interface FactAnchor {
  id: number;
  observationId: number;
  anchorKind: AnchorKind;
  /** Symbol qualified name (e.g. `module.Class.method`); undefined for file anchors. */
  qualifiedName?: string;
  filePath: string;
  /** 1-based line, when known. */
  line?: number;
  /** Commit the verification was pinned to (`verified` anchors). */
  commitSha?: string;
  /** Branch the anchor was last verified true on (FR-C1); undefined when unknown. */
  branch?: string;
  state: AnchorState;
  /** ISO timestamp of the last successful verification. */
  verifiedAt?: string;
  createdAt: string;
}

/** Fields accepted when creating a fact anchor. Defaults `state` to `claimed`. */
export interface CreateFactAnchorInput {
  observationId: number;
  anchorKind: AnchorKind;
  qualifiedName?: string;
  filePath: string;
  line?: number;
  commitSha?: string;
  branch?: string;
  /** Defaults to `claimed` when omitted. */
  state?: AnchorState;
  verifiedAt?: string;
  /** Defaults to now (ISO) when omitted. */
  createdAt?: string;
}
