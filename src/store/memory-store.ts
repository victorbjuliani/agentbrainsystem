/**
 * MemoryStore — the durable SQLite persistence layer (issue #3).
 *
 * Owns the single embedded DB: relational rows + the `vec0` vector index +
 * the FTS5 keyword index, all in one file at `config.dbPath`. It provides:
 *
 *   - lifecycle: `open` / `close` / `runMigrations` (migrations run on open)
 *   - CRUD: sessions and observations
 *   - low-level index primitives: `upsertVector` / `removeVector` /
 *     `indexFts` / `removeFts` (the indexer in #5 orchestrates *when* these run;
 *     this layer only provides the operations)
 *   - read helpers the recall layer (#6) needs: `knn`, `searchFts`,
 *     `getObservation`, `listObservations`, `iterateObservations`
 *   - `counts()` returning REAL row counts (agentmemory's status was cosmetic)
 *
 * Gotchas baked in from ADR 0001 / the spike:
 *   - vec0 rowid MUST be bound as BigInt (a JS number binds as REAL → rejected).
 *   - vectors bind into vec0 as a JSON string (`JSON.stringify(arr)`), not a
 *     Float32Array.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { MIGRATIONS, runDdl } from './schema.js';
import type {
  CountsResult,
  CreateObservationInput,
  CreateSessionInput,
  KnnHit,
  ListObservationsOptions,
  Observation,
  Session,
  StoreOptions,
} from './types.js';

/** Shape of an `observations` row as stored (snake_case, JSON as text). */
interface ObservationRow {
  id: number;
  session_id: number;
  kind: string;
  content: string;
  metadata: string | null;
  source: string | null;
  created_at: string;
}

/** Shape of a `sessions` row as stored. */
interface SessionRow {
  id: number;
  external_id: string;
  project: string | null;
  started_at: string | null;
  created_at: string;
  meta: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Parse a nullable JSON text column into a plain object, tolerating null/garbage. */
function parseJson(text: string | null): Record<string, unknown> | undefined {
  if (text == null) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    externalId: row.external_id,
    project: row.project ?? undefined,
    startedAt: row.started_at ?? undefined,
    createdAt: row.created_at,
    meta: parseJson(row.meta),
  };
}

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    content: row.content,
    metadata: parseJson(row.metadata),
    source: row.source ?? undefined,
    createdAt: row.created_at,
  };
}

export class MemoryStore {
  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private readonly dimensions: number;

  constructor(options: StoreOptions) {
    this.dbPath = options.dbPath;
    this.dimensions = options.dimensions;
  }

  /** Open (or create) the DB, load sqlite-vec, set durable pragmas, run migrations. */
  open(dbPath?: string): this {
    if (this.db) return this; // already open — idempotent
    const path = dbPath ?? this.dbPath;
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new Database(path);
    sqliteVec.load(db);
    db.pragma('journal_mode = WAL'); // durability across restarts
    db.pragma('foreign_keys = ON'); // honour ON DELETE CASCADE
    this.db = db;
    this.runMigrations();
    return this;
  }

  /** Close the underlying connection. Safe to call when already closed. */
  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  private conn(): Database.Database {
    if (!this.db) throw new Error('MemoryStore is not open — call open() first');
    return this.db;
  }

  // ---------------------------------------------------------------- migrations

  /** Apply any pending forward migrations. Idempotent — a no-op on a current DB. */
  runMigrations(): void {
    const db = this.conn();
    runDdl(
      db,
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );`,
    );

    const appliedRow = db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
      .get() as { v: number };
    const applied = appliedRow.v;

    const record = db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    );

    for (const migration of MIGRATIONS) {
      if (migration.version <= applied) continue;
      const tx = db.transaction(() => {
        migration.up(db, this.dimensions);
        record.run(migration.version, migration.name, nowIso());
      });
      tx();
    }
  }

  /** The highest applied migration version. */
  schemaVersion(): number {
    const db = this.conn();
    const row = db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
      .get() as { v: number };
    return row.v;
  }

  // ------------------------------------------------------------ session CRUD

  createSession(input: CreateSessionInput): number {
    const db = this.conn();
    const createdAt = input.createdAt ?? nowIso();
    const info = db
      .prepare(
        `INSERT INTO sessions (external_id, project, started_at, created_at, meta)
         VALUES (@externalId, @project, @startedAt, @createdAt, @meta)`,
      )
      .run({
        externalId: input.externalId,
        project: input.project ?? null,
        startedAt: input.startedAt ?? null,
        createdAt,
        meta: input.meta ? JSON.stringify(input.meta) : null,
      });
    return Number(info.lastInsertRowid);
  }

  getSession(id: number): Session | null {
    const row = this.conn().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    return row ? rowToSession(row) : null;
  }

  getSessionByExternalId(externalId: string): Session | null {
    const row = this.conn()
      .prepare('SELECT * FROM sessions WHERE external_id = ?')
      .get(externalId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  listSessions(): Session[] {
    const rows = this.conn()
      .prepare('SELECT * FROM sessions ORDER BY id ASC')
      .all() as SessionRow[];
    return rows.map(rowToSession);
  }

  /** Delete a session. Observations cascade; their vector/fts entries are pruned too. */
  deleteSession(id: number): void {
    const db = this.conn();
    const tx = db.transaction((sessionId: number) => {
      const obsIds = db
        .prepare('SELECT id FROM observations WHERE session_id = ?')
        .all(sessionId) as Array<{ id: number }>;
      for (const { id: obsId } of obsIds) {
        this.removeVector(obsId);
        this.removeFts(obsId);
      }
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    });
    tx(id);
  }

  // -------------------------------------------------------- observation CRUD

  createObservation(input: CreateObservationInput): number {
    const db = this.conn();
    const createdAt = input.createdAt ?? nowIso();
    const info = db
      .prepare(
        `INSERT INTO observations (session_id, kind, content, metadata, source, created_at)
         VALUES (@sessionId, @kind, @content, @metadata, @source, @createdAt)`,
      )
      .run({
        sessionId: input.sessionId,
        kind: input.kind,
        content: input.content,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        source: input.source ?? null,
        createdAt,
      });
    return Number(info.lastInsertRowid);
  }

  getObservation(id: number): Observation | null {
    const row = this.conn().prepare('SELECT * FROM observations WHERE id = ?').get(id) as
      | ObservationRow
      | undefined;
    return row ? rowToObservation(row) : null;
  }

  listObservations(options: ListObservationsOptions = {}): Observation[] {
    const db = this.conn();
    const { sql, params } = this.buildObservationQuery(options);
    const rows = db.prepare(sql).all(params) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  /**
   * Stream observations one row at a time. Prefer this over `listObservations`
   * when walking the whole store (e.g. an index rebuild) — it avoids
   * materializing every row at once (8 GB footprint discipline, ADR 0001).
   */
  *iterateObservations(options: ListObservationsOptions = {}): IterableIterator<Observation> {
    const db = this.conn();
    const { sql, params } = this.buildObservationQuery(options);
    const stmt = db.prepare(sql);
    for (const row of stmt.iterate(params) as IterableIterator<ObservationRow>) {
      yield rowToObservation(row);
    }
  }

  /** Build the parameterized SELECT shared by list + iterate. */
  private buildObservationQuery(options: ListObservationsOptions): {
    sql: string;
    params: Record<string, unknown>;
  } {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (options.sessionId !== undefined) {
      clauses.push('session_id = @sessionId');
      params.sessionId = options.sessionId;
    }
    if (options.kind !== undefined) {
      clauses.push('kind = @kind');
      params.kind = options.kind;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = options.limit !== undefined ? 'LIMIT @limit' : '';
    if (options.limit !== undefined) params.limit = options.limit;
    return {
      sql: `SELECT * FROM observations ${where} ORDER BY id ASC ${limit}`,
      params,
    };
  }

  /** Delete one observation and prune its vector + fts entries. */
  deleteObservation(id: number): void {
    const db = this.conn();
    const tx = db.transaction((obsId: number) => {
      this.removeVector(obsId);
      this.removeFts(obsId);
      db.prepare('DELETE FROM observations WHERE id = ?').run(obsId);
    });
    tx(id);
  }

  // ----------------------------------------------------- vector index (vec0)

  /**
   * Insert-or-replace the embedding for an observation. The rowid is bound as
   * BigInt and the vector as a JSON string — both required by sqlite-vec.
   */
  upsertVector(obsId: number, vector: number[]): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`,
      );
    }
    const db = this.conn();
    const rowid = BigInt(obsId);
    const json = JSON.stringify(vector);
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM vec_observations WHERE rowid = ?').run(rowid);
      db.prepare('INSERT INTO vec_observations (rowid, embedding) VALUES (?, ?)').run(rowid, json);
    });
    tx();
  }

  /** Remove an observation's embedding from the vector index (no-op if absent). */
  removeVector(obsId: number): void {
    this.conn().prepare('DELETE FROM vec_observations WHERE rowid = ?').run(BigInt(obsId));
  }

  /** Drop every row from the vector index. Used by a deterministic rebuild (#5). */
  clearVectorIndex(): void {
    this.conn().prepare('DELETE FROM vec_observations').run();
  }

  /** k-nearest-neighbour search over the vector index, ordered by distance. */
  knn(query: number[], k: number): KnnHit[] {
    if (query.length !== this.dimensions) {
      throw new Error(`query dimension mismatch: expected ${this.dimensions}, got ${query.length}`);
    }
    const rows = this.conn()
      .prepare(
        `SELECT rowid AS id, distance
         FROM vec_observations
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(JSON.stringify(query), k) as Array<{ id: number; distance: number }>;
    return rows.map((r) => ({ id: r.id, distance: r.distance }));
  }

  // -------------------------------------------------------- keyword index (FTS5)

  /** Insert-or-replace the FTS content for an observation, keyed by its rowid. */
  indexFts(obsId: number, content: string): void {
    const db = this.conn();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM fts_observations WHERE rowid = ?').run(obsId);
      db.prepare('INSERT INTO fts_observations (rowid, content) VALUES (?, ?)').run(obsId, content);
    });
    tx();
  }

  /** Remove an observation's FTS entry (no-op if absent). */
  removeFts(obsId: number): void {
    this.conn().prepare('DELETE FROM fts_observations WHERE rowid = ?').run(obsId);
  }

  /** Drop every row from the keyword index. Used by a deterministic rebuild (#5). */
  clearFtsIndex(): void {
    this.conn().prepare('DELETE FROM fts_observations').run();
  }

  /** Full-text search returning matching observation ids ordered by FTS rank. */
  searchFts(queryText: string, k: number): KnnHit[] {
    const rows = this.conn()
      .prepare(
        `SELECT rowid AS id, rank AS distance
         FROM fts_observations
         WHERE fts_observations MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(queryText, k) as Array<{ id: number; distance: number }>;
    return rows.map((r) => ({ id: r.id, distance: r.distance }));
  }

  // ------------------------------------------------------------------- kv meta

  /** Read a bookkeeping value (e.g. the embedding signature the index was built with). */
  getMeta(key: string): string | null {
    const row = this.conn().prepare('SELECT value FROM kv_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  /** Write a bookkeeping value (insert-or-replace). */
  setMeta(key: string, value: string): void {
    this.conn()
      .prepare(
        `INSERT INTO kv_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // -------------------------------------------------------------------- counts

  /** REAL row counts across the relational + index tables. */
  counts(): CountsResult {
    const db = this.conn();
    const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
    return {
      sessions: one('SELECT COUNT(*) AS c FROM sessions'),
      observations: one('SELECT COUNT(*) AS c FROM observations'),
      vectors: one('SELECT COUNT(*) AS c FROM vec_observations'),
      fts: one('SELECT COUNT(*) AS c FROM fts_observations'),
    };
  }
}
