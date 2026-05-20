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
export const CURRENT_SCHEMA_VERSION = 1;

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
];
