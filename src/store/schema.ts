/**
 * Schema + migration definitions for the memory store.
 *
 * The store is a single embedded SQLite DB holding everything: relational rows
 * (`sessions`, `observations`), the vector index (`vec_observations`, a
 * `sqlite-vec` `vec0` virtual table) and the keyword index (`fts_observations`,
 * an FTS5 virtual table). Both index tables are keyed by the integer
 * `observations.id` rowid so the recall layer (#6) can fuse them by id.
 *
 * Migrations are forward-only and idempotent: each runs inside a transaction,
 * guarded by a `schema_migrations` ledger, so opening an existing DB is a no-op.
 */
import type { Database } from 'better-sqlite3';

/** The schema version the running code expects. Bump when adding a migration. */
export const CURRENT_SCHEMA_VERSION = 4;

/**
 * Run a multi-statement DDL/SQL batch on the connection. Thin wrapper over
 * better-sqlite3's batch executor so all schema setup goes through one place.
 */
export function runDdl(db: Database, sql: string): void {
  const run = db.exec.bind(db);
  run(sql);
}

/** A single forward migration step. `up` receives an open DB and the active dimension. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: Database, dimensions: number): void;
}

/**
 * Forward-only migrations, ascending by version. The vec0 column is sized to
 * the active embedding dimension (float[N]); a fixed N is why swapping
 * providers must keep N constant (ADR 0001 dimension guard).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up(db, dimensions) {
      runDdl(
        db,
        `
        CREATE TABLE sessions (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          external_id  TEXT NOT NULL UNIQUE,
          project      TEXT,
          started_at   TEXT,
          created_at   TEXT NOT NULL,
          meta         TEXT
        );

        CREATE TABLE observations (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          kind        TEXT NOT NULL,
          content     TEXT NOT NULL,
          metadata    TEXT,
          source      TEXT,
          created_at  TEXT NOT NULL
        );

        CREATE INDEX idx_observations_session ON observations(session_id);
        CREATE INDEX idx_observations_kind ON observations(kind);
      `,
      );

      // Vector index: vec0 virtual table sized to the active provider dimension.
      // Keyed by observations.id (bound as BigInt at write/query time — see ADR).
      runDdl(
        db,
        `CREATE VIRTUAL TABLE vec_observations USING vec0(embedding float[${dimensions}]);`,
      );

      // Keyword index: FTS5 over observation content, keyed by the same rowid.
      runDdl(db, 'CREATE VIRTUAL TABLE fts_observations USING fts5(content);');
    },
  },
  {
    version: 2,
    name: 'kv-meta',
    up(db) {
      // Small key/value table for index lifecycle bookkeeping (#5): which
      // embedding provider/model/dimension the persisted index was built with,
      // so a deterministic rebuild can fire when that changes (not just on count
      // drift). Keeping it generic avoids a migration per new bookkeeping field.
      runDdl(
        db,
        `CREATE TABLE kv_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );`,
      );
    },
  },
  {
    version: 3,
    name: 'fact-anchors',
    up(db) {
      // The verifiable-memory layer (E): each fact (observation) can carry one
      // or more anchors tying it to a concrete code location. `state` tracks
      // verifiability — `claimed` (seeded from a tool-call, not yet checked),
      // `verified` (resolved against the ground-truth graph, carries
      // file:line@commit), or `stale` (the anchor's symbol/file no longer
      // resolves; self-healing marks, never deletes — auditable).
      //
      // The reverse indexes on `qualified_name` and `file_path` are the whole
      // point of a dedicated table (ADR-0008 / discovery D1): self-healing asks
      // "which facts anchored to symbol X / file Y?" and needs O(log n), which
      // a JSON metadata column cannot serve.
      runDdl(
        db,
        `CREATE TABLE fact_anchors (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          observation_id  INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
          anchor_kind     TEXT NOT NULL,
          qualified_name  TEXT,
          file_path       TEXT NOT NULL,
          line            INTEGER,
          commit_sha      TEXT,
          state           TEXT NOT NULL DEFAULT 'claimed',
          verified_at     TEXT,
          created_at      TEXT NOT NULL
        );

        CREATE INDEX idx_anchors_observation ON fact_anchors(observation_id);
        CREATE INDEX idx_anchors_qname ON fact_anchors(qualified_name);
        CREATE INDEX idx_anchors_file ON fact_anchors(file_path);
        CREATE INDEX idx_anchors_state ON fact_anchors(state);`,
      );
    },
  },
  {
    version: 4,
    name: 'anchor-branch',
    up(db) {
      // Branch scoping (FR-C1): the branch the anchor was last verified true on.
      // Set at verify/heal time from the ground-truth repo's HEAD (accurate —
      // unlike ingest time, where the transcript does not record a per-turn
      // branch). Recall uses it to tag cross-branch facts. Nullable: claimed
      // anchors and offline/no-git contexts simply leave it unset.
      runDdl(db, 'ALTER TABLE fact_anchors ADD COLUMN branch TEXT;');
    },
  },
];
