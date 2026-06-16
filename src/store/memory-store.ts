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
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { observationContentHash } from './content-hash.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, runDdl } from './schema.js';
import type {
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

/** Shape of a `fact_anchors` row as stored (snake_case). */
interface FactAnchorRow {
  id: number;
  observation_id: number;
  anchor_kind: string;
  qualified_name: string | null;
  file_path: string;
  line: number | null;
  commit_sha: string | null;
  branch: string | null;
  state: string;
  verified_at: string | null;
  created_at: string;
}

function rowToAnchor(row: FactAnchorRow): FactAnchor {
  return {
    id: row.id,
    observationId: row.observation_id,
    anchorKind: row.anchor_kind as FactAnchor['anchorKind'],
    qualifiedName: row.qualified_name ?? undefined,
    filePath: row.file_path,
    line: row.line ?? undefined,
    commitSha: row.commit_sha ?? undefined,
    branch: row.branch ?? undefined,
    state: row.state as AnchorState,
    verifiedAt: row.verified_at ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Thrown when `memory.db` fails its integrity check (or SQLite reports it is not
 * a database) at open. Distinct type so callers (the CLI, hooks) can give an
 * actionable message — restore from a backup / run `abs doctor` — instead of a
 * raw SQLite stack trace. Hooks still fail-open (ADR-0004): the runner swallows
 * it to stderr without crashing the agent session.
 */
export class CorruptStoreError extends Error {
  readonly dbPath: string;
  constructor(dbPath: string, detail: string) {
    super(
      `memory.db appears corrupt (${dbPath}): ${detail}. ` +
        'Restore from your last `abs export`, or copy back the `.bak` next to the db, ' +
        'then run `abs doctor` to confirm.',
    );
    this.name = 'CorruptStoreError';
    this.dbPath = dbPath;
  }
}

/**
 * Thrown when `memory.db` was stamped by a NEWER `abs` than the running code
 * (its applied schema version exceeds {@link CURRENT_SCHEMA_VERSION}). Migrations
 * are forward-only (`schema.ts`), so running the old code against a newer DB could
 * silently misbehave — we refuse instead (#112). Distinct type so callers can give
 * an actionable upgrade message rather than an obscure query failure later. Hooks
 * still fail-open (ADR-0004): the runner swallows it to stderr.
 */
export class SchemaDowngradeError extends Error {
  readonly dbPath: string;
  readonly dbVersion: number;
  readonly codeVersion: number;
  constructor(dbPath: string, dbVersion: number, codeVersion: number) {
    super(
      `memory.db (${dbPath}) was created by a newer abs (schema v${dbVersion}); ` +
        `this abs only understands schema v${codeVersion}. ` +
        'Upgrade abs (`git pull && npm run build`), or export from the newer abs and ' +
        'reimport. Refusing to run against a newer database.',
    );
    this.name = 'SchemaDowngradeError';
    this.dbPath = dbPath;
    this.dbVersion = dbVersion;
    this.codeVersion = codeVersion;
  }
}

/** Result of a `PRAGMA quick_check` — `ok:true` means SQLite found no problems. */
export interface IntegrityResult {
  ok: boolean;
  errors: string[];
}

/** Back up the db at most once per this window (a file copy is cheap but not free). */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a backup is due given the existing backup's mtime. A missing backup
 * (`bakMtimeMs === null`) is always due; otherwise only once per BACKUP_INTERVAL_MS.
 * Pure so the daily gate is unit-testable without touching the clock or disk.
 */
export function backupIsDue(bakMtimeMs: number | null, nowMs: number): boolean {
  if (bakMtimeMs === null) return true;
  return nowMs - bakMtimeMs >= BACKUP_INTERVAL_MS;
}

/**
 * Crash-safe backup write (F1-04): copy `srcPath` to a temp sibling, VALIDATE the
 * copy opened as a structurally-sound db (`quick_check`), then atomically `rename`
 * it onto `bakPath`. Returns `true` when a fresh, valid backup was promoted.
 *
 * Why not `copyFileSync(src, bak)` directly: a copy interrupted mid-write overwrites
 * the previous GOOD `.bak` with a torn one, destroying the only recovery point. With
 * temp+rename an interrupt leaves only the temp; the prior `.bak` is untouched. The
 * post-copy `quick_check` is the "validate before replacing" guard — a torn copy
 * never replaces a good backup. Best-effort: never throws, always cleans the temp.
 */
export function writeValidatedBackup(srcPath: string, bakPath: string): boolean {
  const tmp = `${bakPath}.tmp-${process.pid}`;
  // Opening the copy as a WAL db spawns `-wal`/`-shm` sidecars next to `tmp`; clean
  // the whole set so no scratch file (main or sidecar) ever lingers in the data dir.
  const cleanup = () => {
    for (const p of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* nothing to clean */
      }
    }
  };
  try {
    copyFileSync(srcPath, tmp);
    const probe = new Database(tmp, { readonly: true });
    try {
      sqliteVec.load(probe); // mirror open(): the db carries vec0 virtual tables
      const rows = probe.pragma('quick_check') as Array<{ quick_check: string }>;
      if (!(rows.length === 1 && rows[0]?.quick_check === 'ok')) return false;
    } finally {
      probe.close();
    }
    renameSync(tmp, bakPath); // atomic replace of the previous good backup
    return true;
  } catch {
    return false; // torn copy / validation failure → leave the prior good .bak alone
  } finally {
    cleanup(); // rename consumed the main temp on success; drop any leftover sidecars
  }
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
    const onDisk = path !== ':memory:';
    if (onDisk) {
      mkdirSync(dirname(path), { recursive: true });
    }
    // A db file that already existed before this open is the only thing worth
    // protecting: capture it now, before `new Database` may create an empty file.
    const preexisting = onDisk && existsSync(path);

    // A truncated / non-db / corrupt file can surface its error at any point from
    // `new Database` through the first pragma — wrap the whole bring-up so every
    // such failure becomes an actionable CorruptStoreError instead of a raw throw
    // that fail-opens into silence. quick_check is the explicit structural probe.
    try {
      const db = new Database(path);
      sqliteVec.load(db);
      db.pragma('journal_mode = WAL'); // durability across restarts
      db.pragma('busy_timeout = 5000'); // wait up to 5s for a concurrent writer before SQLITE_BUSY
      db.pragma('foreign_keys = ON'); // honour ON DELETE CASCADE
      // Bound the -wal on a long-lived read-mostly server (the MCP stdio process):
      // checkpoint into the db roughly every 1000 pages instead of letting the WAL
      // grow unbounded between the infrequent writes (#103).
      db.pragma('wal_autocheckpoint = 1000');
      this.db = db;

      // Fast structural integrity check, once per process open. quick_check skips
      // the (expensive) per-row index cross-check that full integrity_check does,
      // but catches a corrupt/truncated/non-db file — the failure mode that today
      // fail-opens into a silent total memory outage.
      const integrity = this.quickCheck();
      if (!integrity.ok) {
        throw new CorruptStoreError(path, integrity.errors.join('; '));
      }
    } catch (e) {
      this.close();
      if (e instanceof CorruptStoreError) throw e;
      if (e instanceof Error && /not a database|corrupt|malformed|encrypted/i.test(e.message)) {
        throw new CorruptStoreError(path, e.message);
      }
      throw e;
    }

    // Backup-on-open: a verified-intact db, snapshotted at most once a day, is the
    // only recovery path today (besides a manual `abs export`). mtime-gated so it
    // is a no-op on every subsequent open within the window.
    if (preexisting) this.maybeBackup(path);

    // runMigrations runs OUTSIDE the bring-up try/catch above, but it can still throw
    // (SchemaDowngradeError on a newer-than-code DB, #112). Mirror the corruption path:
    // never leak the live connection on a failed open, or a caller that fails open
    // (hooks, ADR-0004) would retain a WAL/lock-holding handle for the whole process.
    try {
      this.runMigrations();
    } catch (e) {
      this.close();
      throw e;
    }
    return this;
  }

  /** Path of the rotating backup created on open: the db file with a `.bak` suffix. */
  backupPath(dbPath?: string): string {
    return `${dbPath ?? this.dbPath}.bak`;
  }

  /**
   * Copy the (already integrity-checked) db to `<db>.bak` when a backup is due.
   *
   * The `.bak` is a single-file copy of `memory.db` alone, so it must contain
   * every committed frame BEFORE the copy — otherwise restoring it silently
   * loses recent writes still sitting in the WAL. `wal_checkpoint(TRUNCATE)`
   * does not throw when readers/writers block it; it returns `busy = 1` and
   * leaves frames behind. So we inspect the result and SKIP the backup when the
   * checkpoint did not fully drain the WAL — a stale recovery point is worse
   * than retrying on the next open. Best-effort: never blocks open.
   */
  private maybeBackup(path: string): void {
    try {
      const bak = this.backupPath(path);
      const bakMtime = existsSync(bak) ? statSync(bak).mtimeMs : null;
      if (!backupIsDue(bakMtime, Date.now())) return;
      // TRUNCATE (not FULL) so a clean checkpoint also zeroes the WAL, leaving the
      // single db file fully self-contained for the copy.
      const [result] = this.conn().pragma('wal_checkpoint(TRUNCATE)') as Array<{
        busy: number;
        log: number;
        checkpointed: number;
      }>;
      // busy !== 0 → the WAL was not fully flushed into the db file; copying now
      // would capture an incomplete snapshot. Skip and retry on a later open.
      if (result && result.busy !== 0) return;
      // F1-04: copy → validate → atomic rename, never `copyFileSync` straight onto
      // the live `.bak`. A direct copy interrupted mid-write (crash/kill) leaves a
      // TORN `.bak` that has already overwritten the previous good one — the recovery
      // point is then silently destroyed. Writing a temp and renaming means an
      // interrupt only ever leaves the temp; the prior good `.bak` stays intact.
      writeValidatedBackup(path, bak);
    } catch {
      // A failed backup is non-fatal — the store is still usable this session.
    }
  }

  /**
   * Run `PRAGMA quick_check` and report whether SQLite found structural problems.
   * `ok:true` ⇔ the single result row is the literal `ok`. Used at open and by
   * `abs doctor`.
   */
  quickCheck(): IntegrityResult {
    const rows = this.conn().pragma('quick_check') as Array<{ quick_check: string }>;
    const messages = rows.map((r) => r.quick_check).filter((m) => m !== 'ok');
    return { ok: messages.length === 0, errors: messages };
  }

  /** Size of the write-ahead log file in bytes (0 when absent or in-memory). */
  walSizeBytes(): number {
    if (this.dbPath === ':memory:') return 0;
    const wal = `${this.dbPath}-wal`;
    return existsSync(wal) ? statSync(wal).size : 0;
  }

  /** Close the underlying connection. Safe to call when already closed. */
  close(): void {
    if (!this.db) return;
    // Fold the WAL back into the db on the way out so the -wal doesn't linger and
    // a backup/copy of the db file is current (#103). Best-effort — a busy
    // checkpoint must never prevent close.
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore — closing anyway
    }
    this.db.close();
    this.db = null;
  }

  private conn(): Database.Database {
    if (!this.db) throw new Error('MemoryStore is not open — call open() first');
    return this.db;
  }

  /** The vector width this store's `vec0` column is sized for. */
  get vectorDimensions(): number {
    return this.dimensions;
  }

  // ---------------------------------------------------------------- migrations

  /** Apply any pending forward migrations. Idempotent — a no-op on a current DB. */
  runMigrations(): void {
    const db = this.conn();
    // F1-05: serialize fresh-DB migrations ACROSS PROCESSES. The read (MAX version)
    // and the apply must be ONE write-locked unit — otherwise two processes opening
    // the same fresh db both read applied=0, both run migration 1, and collide on the
    // `schema_migrations` PK (or double-run a non-idempotent `up`). `BEGIN IMMEDIATE`
    // takes the RESERVED lock up front, so a concurrent opener blocks on the 5s
    // `busy_timeout`, then re-reads the now-current version INSIDE its own txn and the
    // loop is a clean no-op. (The schema_migrations DDL moves inside the txn too —
    // DDL is transactional in SQLite, so the whole check+apply is atomic.)
    const migrate = db.transaction(() => {
      runDdl(
        db,
        `CREATE TABLE IF NOT EXISTS schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );`,
      );

      const applied = (
        db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as {
          v: number;
        }
      ).v;

      // Forward-only guard (#112): a DB stamped by a NEWER abs must NOT be opened by
      // this (older) code — migrations only go up, so we cannot reconcile a newer
      // schema and queries could silently misbehave. Refuse with an actionable error.
      if (applied > CURRENT_SCHEMA_VERSION) {
        throw new SchemaDowngradeError(this.dbPath, applied, CURRENT_SCHEMA_VERSION);
      }

      const record = db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      );

      for (const migration of MIGRATIONS) {
        if (migration.version <= applied) continue;
        migration.up(db, this.dimensions);
        record.run(migration.version, migration.name, nowIso());
      }
    });
    // .immediate ⇒ BEGIN IMMEDIATE (acquire the write lock at txn start, not first write).
    migrate.immediate();
  }

  /** The highest applied migration version. */
  schemaVersion(): number {
    const db = this.conn();
    const row = db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
      .get() as { v: number };
    return row.v;
  }

  /**
   * Run `fn` inside ONE atomic transaction and return its result. better-sqlite3
   * is synchronous, so the whole closure commits or rolls back as a unit; nested
   * `db.transaction` calls (e.g. `deleteObservation`) fold into savepoints. Lets a
   * higher layer (the delete core, #N) make a multi-row delete atomic without
   * reaching into the private connection.
   */
  transaction<T>(fn: () => T): () => T {
    return this.conn().transaction(fn);
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

  /**
   * Distinct non-NULL project labels currently in use, sorted. Drives the
   * `abs project` picker (#51) — "existing projects" the user can link to. A
   * row whose project IS NULL (auto-derivation never ran / cleared) is excluded;
   * the literal string `'null'` is a real label and IS included.
   */
  listProjects(): string[] {
    const rows = this.conn()
      .prepare(
        "SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL AND project != '__global__' ORDER BY project",
      )
      .all() as Array<{ project: string }>;
    return rows.map((r) => r.project);
  }

  /**
   * Sessions ordered by their latest observation activity (MAX(observations.
   * created_at)), most-active first. This is "most recently ACTIVE" — distinct
   * from `sessions.created_at`, which is ingest wall-clock and would make
   * "latest session" mean "last ingested". Sessions with zero observations
   * (MAX is NULL) sort last; `id DESC` is the deterministic tiebreaker.
   *
   * `listSessions()` (full, id-ASC) stays the contract for export; this is the
   * read primitive the UI graph (#11) uses to pick its default scope.
   */
  listSessionsByActivity(limit?: number): Session[] {
    const db = this.conn();
    const limitClause = limit !== undefined ? 'LIMIT @limit' : '';
    const rows = db
      .prepare(
        `SELECT s.* FROM sessions s
         LEFT JOIN observations o ON o.session_id = s.id
         GROUP BY s.id
         ORDER BY MAX(o.created_at) DESC NULLS LAST, s.id DESC
         ${limitClause}`,
      )
      .all(limit !== undefined ? { limit } : {}) as SessionRow[];
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
    // Content-hash idempotence (#105): identical (session, content, source) is the
    // same observation. ON CONFLICT DO NOTHING makes a re-ingest a no-op rather than
    // a duplicate row; on conflict we return the EXISTING row's id so the write path
    // (index-at-write) stays a stable upsert on that id.
    const contentHash = observationContentHash(input.sessionId, input.content, input.source);
    const info = db
      .prepare(
        `INSERT INTO observations (session_id, kind, content, metadata, source, created_at, content_hash)
         VALUES (@sessionId, @kind, @content, @metadata, @source, @createdAt, @contentHash)
         ON CONFLICT(content_hash) DO NOTHING`,
      )
      .run({
        sessionId: input.sessionId,
        kind: input.kind,
        content: input.content,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        source: input.source ?? null,
        createdAt,
        contentHash,
      });
    if (info.changes > 0) return Number(info.lastInsertRowid);
    // Conflict → the row already exists; return its id (idempotent re-ingest).
    const existing = db
      .prepare('SELECT id FROM observations WHERE content_hash = ?')
      .get(contentHash) as { id: number } | undefined;
    if (existing) return existing.id;
    throw new Error('content_hash conflict but no existing observation found');
  }

  getObservation(id: number): Observation | null {
    const row = this.conn().prepare('SELECT * FROM observations WHERE id = ?').get(id) as
      | ObservationRow
      | undefined;
    return row ? rowToObservation(row) : null;
  }

  /**
   * Re-link an observation to a different session (used by `promote` to lift a
   * project memory into the global brain). The observation id (= fts/vec rowid)
   * is unchanged, so the FTS and vector indexes stay valid; only the FK moves.
   */
  moveObservationToSession(observationId: number, sessionId: number): void {
    this.conn()
      .prepare('UPDATE observations SET session_id = ? WHERE id = ?')
      .run(sessionId, observationId);
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

  /**
   * Observations tagged with `metadata.sourceSession = N` — i.e. the lessons/decisions
   * a consolidation run produced FROM session N. Used for idempotency checks and
   * --force replace. Optionally narrow by `source` (e.g. 'consolidate') so an
   * unrelated user observation that merely carries a sourceSession value can't
   * false-positive.
   *
   * `json_extract` returns NULL for NULL/absent metadata, and `NULL = @sourceSession`
   * is false in SQL, so rows without the field are cleanly excluded — no exception.
   */
  listObservationsBySourceSession(
    sourceSession: number,
    opts?: { source?: string },
  ): Observation[] {
    const db = this.conn();
    const params: Record<string, unknown> = { sourceSession };
    let sourceClause = '';
    if (opts?.source !== undefined) {
      sourceClause = ' AND source = @source';
      params.source = opts.source;
    }
    const rows = db
      .prepare(
        `SELECT * FROM observations
         WHERE json_extract(metadata, '$.sourceSession') = @sourceSession${sourceClause}
         ORDER BY id ASC`,
      )
      .all(params) as ObservationRow[];
    return rows.map(rowToObservation);
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
    if (options.project !== undefined) {
      // Scope to the sessions of one project via a subquery (no JOIN — keeps the
      // `SELECT *` shape unchanged for rowToObservation). Parameterized.
      clauses.push('session_id IN (SELECT id FROM sessions WHERE project = @project)');
      params.project = options.project;
    }
    if (options.kind !== undefined) {
      clauses.push('kind = @kind');
      params.kind = options.kind;
    }
    if (options.kinds !== undefined && options.kinds.length > 0) {
      // better-sqlite3 named params don't expand arrays — bind one placeholder per
      // value (@kind0, @kind1, …) so `kind IN (…)` is parameterized, never inlined.
      const placeholders = options.kinds.map((_, i) => `@kind${i}`).join(', ');
      clauses.push(`kind IN (${placeholders})`);
      options.kinds.forEach((k, i) => {
        params[`kind${i}`] = k;
      });
    }
    if (options.afterId !== undefined) {
      clauses.push('id > @afterId');
      params.afterId = options.afterId;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = options.limit !== undefined ? 'LIMIT @limit' : '';
    if (options.limit !== undefined) params.limit = options.limit;
    // Default 'asc' keeps every existing caller byte-for-byte unchanged.
    const direction = options.order === 'desc' ? 'DESC' : 'ASC';
    return {
      sql: `SELECT * FROM observations ${where} ORDER BY id ${direction} ${limit}`,
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

  /**
   * k-nearest-neighbour search over the vector index, ordered by distance. When
   * `project` is given, restrict to observations whose session is filed under that
   * project (#47 — project-scoped recall): a `rowid IN (…)` subquery joins
   * `observations → sessions`, applied alongside the vec0 KNN MATCH (sqlite-vec
   * supports the extra rowid constraint). Omit `project` for store-wide recall —
   * byte-for-byte the original query.
   */
  knn(query: number[], k: number, project?: string, includeGlobal = false): KnnHit[] {
    if (query.length !== this.dimensions) {
      throw new Error(`query dimension mismatch: expected ${this.dimensions}, got ${query.length}`);
    }
    const conn = this.conn();
    const vec = JSON.stringify(query);
    let rows: Array<{ id: number | bigint; distance: number }>;
    if (project === undefined) {
      rows = conn
        .prepare(
          `SELECT rowid AS id, distance FROM vec_observations
           WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
        )
        .all(vec, k) as never;
    } else {
      // Widen ONLY the rowid subquery to include the global session; never JOIN the
      // vec0 SELECT (it would break sqlite-vec's KNN planner) and keep the {id,distance}
      // shape — global tagging is driven by searchFts on the FTS-first per-prompt path.
      const projectFilter = includeGlobal
        ? "s.project = ? OR s.project = '__global__'"
        : 's.project = ?';
      rows = conn
        .prepare(
          `SELECT v.rowid AS id, v.distance AS distance
           FROM vec_observations v
           WHERE v.embedding MATCH ?
             AND v.rowid IN (
               SELECT o.id FROM observations o
               JOIN sessions s ON s.id = o.session_id
               WHERE ${projectFilter}
             )
           ORDER BY v.distance LIMIT ?`,
        )
        .all(vec, project, k) as never;
    }
    return rows.map((r) => ({ id: Number(r.id), distance: r.distance }));
  }

  /**
   * Read back an observation's stored embedding as a plain number[] (via
   * sqlite-vec `vec_to_json`), or null if absent. Used by export (#8) to ship
   * vectors so an imported store recalls identically without re-embedding.
   */
  getVector(obsId: number): number[] | null {
    const row = this.conn()
      .prepare('SELECT vec_to_json(embedding) AS j FROM vec_observations WHERE rowid = ?')
      .get(BigInt(obsId)) as { j: string } | undefined;
    return row ? (JSON.parse(row.j) as number[]) : null;
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

  /**
   * Remove index rows (vector + FTS) whose observation no longer exists. Lets a
   * rebuild upsert-replace in place instead of clearing first, so recall never
   * sees an empty index mid-rebuild.
   */
  pruneIndexOrphans(): void {
    const db = this.conn();
    const tx = db.transaction(() => {
      db.prepare(
        'DELETE FROM vec_observations WHERE rowid NOT IN (SELECT id FROM observations)',
      ).run();
      db.prepare(
        'DELETE FROM fts_observations WHERE rowid NOT IN (SELECT id FROM observations)',
      ).run();
    });
    tx();
  }

  /**
   * Full-text search returning matching observation ids ordered by FTS rank. When
   * `project` is given, restrict to observations whose session is filed under that
   * project (#47): an inner JOIN `fts_observations → observations → sessions` on
   * `sessions.project = ?` (which also excludes NULL-project rows). Omit `project`
   * for store-wide search — byte-for-byte the original query.
   */
  searchFts(queryText: string, k: number, project?: string, includeGlobal = false): KnnHit[] {
    const conn = this.conn();
    const base = `SELECT f.rowid AS id, f.rank AS distance, s.project AS project, o.kind AS kind
       FROM fts_observations f
       JOIN observations o ON o.id = f.rowid
       JOIN sessions s ON s.id = o.session_id
       WHERE fts_observations MATCH ?`;
    let rows: Array<{
      id: number | bigint;
      distance: number;
      project: string | null;
      kind: string;
    }>;
    if (project === undefined) {
      rows = conn.prepare(`${base} ORDER BY f.rank LIMIT ?`).all(queryText, k) as never;
    } else if (includeGlobal) {
      rows = conn
        .prepare(`${base} AND (s.project = ? OR s.project = '__global__') ORDER BY f.rank LIMIT ?`)
        .all(queryText, project, k) as never;
    } else {
      rows = conn
        .prepare(`${base} AND s.project = ? ORDER BY f.rank LIMIT ?`)
        .all(queryText, project, k) as never;
    }
    return rows.map((r) => ({
      id: Number(r.id),
      distance: r.distance,
      project: r.project,
      kind: r.kind,
    }));
  }

  // -------------------------------------------------------- fact anchors (E)

  /**
   * Create a fact anchor tying an observation to a code location. Defaults
   * `state` to `claimed` — the seed step (#25) writes claims; the sweep (#26)
   * promotes them to `verified`. Returns the new anchor id.
   */
  createAnchor(input: CreateFactAnchorInput): number {
    const db = this.conn();
    const info = db
      .prepare(
        `INSERT INTO fact_anchors
           (observation_id, anchor_kind, qualified_name, file_path, line, commit_sha, branch, state, verified_at, created_at)
         VALUES (@observationId, @anchorKind, @qualifiedName, @filePath, @line, @commitSha, @branch, @state, @verifiedAt, @createdAt)`,
      )
      .run({
        observationId: input.observationId,
        anchorKind: input.anchorKind,
        qualifiedName: input.qualifiedName ?? null,
        filePath: input.filePath,
        line: input.line ?? null,
        commitSha: input.commitSha ?? null,
        branch: input.branch ?? null,
        state: input.state ?? 'claimed',
        verifiedAt: input.verifiedAt ?? null,
        createdAt: input.createdAt ?? nowIso(),
      });
    return Number(info.lastInsertRowid);
  }

  /** All anchors for one observation (the recall layer reads these to label freshness). */
  getAnchorsForObservation(observationId: number): FactAnchor[] {
    const rows = this.conn()
      .prepare('SELECT * FROM fact_anchors WHERE observation_id = ? ORDER BY id ASC')
      .all(observationId) as FactAnchorRow[];
    return rows.map(rowToAnchor);
  }

  /**
   * Reverse lookup: every anchor pointing at a symbol. This is the access
   * pattern self-healing (#28) is built around — "symbol X changed, which facts
   * must be re-verified?" — served by `idx_anchors_qname`.
   */
  findAnchorsBySymbol(qualifiedName: string): FactAnchor[] {
    const rows = this.conn()
      .prepare('SELECT * FROM fact_anchors WHERE qualified_name = ? ORDER BY id ASC')
      .all(qualifiedName) as FactAnchorRow[];
    return rows.map(rowToAnchor);
  }

  /** Reverse lookup by file path (served by `idx_anchors_file`). */
  findAnchorsByFile(filePath: string): FactAnchor[] {
    const rows = this.conn()
      .prepare('SELECT * FROM fact_anchors WHERE file_path = ? ORDER BY id ASC')
      .all(filePath) as FactAnchorRow[];
    return rows.map(rowToAnchor);
  }

  /** Anchors in a given verifiability state (the sweep walks `claimed`; audits walk `stale`). */
  listAnchorsByState(state: AnchorState, limit?: number): FactAnchor[] {
    const limitClause = limit !== undefined ? 'LIMIT @limit' : '';
    const rows = this.conn()
      .prepare(`SELECT * FROM fact_anchors WHERE state = @state ORDER BY id ASC ${limitClause}`)
      .all(limit !== undefined ? { state, limit } : { state }) as FactAnchorRow[];
    return rows.map(rowToAnchor);
  }

  /**
   * Transition an anchor's verifiability state. Promotion to `verified` pins the
   * resolved `commitSha`/`line` and stamps `verifiedAt`; marking `stale` (self-
   * healing) keeps the row — invalidation is never deletion (auditable).
   */
  updateAnchorState(
    id: number,
    state: AnchorState,
    opts: { commitSha?: string; line?: number; branch?: string; verifiedAt?: string } = {},
  ): void {
    this.conn()
      .prepare(
        `UPDATE fact_anchors
         SET state = @state,
             commit_sha = COALESCE(@commitSha, commit_sha),
             line = COALESCE(@line, line),
             branch = COALESCE(@branch, branch),
             verified_at = COALESCE(@verifiedAt, verified_at)
         WHERE id = @id`,
      )
      .run({
        id,
        state,
        commitSha: opts.commitSha ?? null,
        line: opts.line ?? null,
        branch: opts.branch ?? null,
        verifiedAt: opts.verifiedAt ?? (state === 'verified' ? nowIso() : null),
      });
  }

  /**
   * Move a verified anchor to a new location (self-healing rename path, #28):
   * the symbol survived but relocated, so we keep `verified` and re-pin
   * file/line/commit instead of marking it stale.
   */
  reanchorAnchor(
    id: number,
    location: { filePath: string; line?: number; commitSha?: string; branch?: string },
  ): void {
    this.conn()
      .prepare(
        `UPDATE fact_anchors
         SET file_path = @filePath,
             line = @line,
             commit_sha = COALESCE(@commitSha, commit_sha),
             branch = COALESCE(@branch, branch),
             verified_at = @verifiedAt
         WHERE id = @id`,
      )
      .run({
        id,
        filePath: location.filePath,
        line: location.line ?? null,
        commitSha: location.commitSha ?? null,
        branch: location.branch ?? null,
        verifiedAt: nowIso(),
      });
  }

  /** Count anchors per verifiability state — feeds the O2 anchor-coverage metric. */
  countAnchorsByState(): Record<AnchorState, number> {
    const rows = this.conn()
      .prepare('SELECT state, COUNT(*) AS c FROM fact_anchors GROUP BY state')
      .all() as Array<{ state: string; c: number }>;
    const out: Record<AnchorState, number> = { claimed: 0, verified: 0, stale: 0 };
    for (const r of rows) {
      if (r.state === 'claimed' || r.state === 'verified' || r.state === 'stale') {
        out[r.state] = r.c;
      }
    }
    return out;
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

  /**
   * Atomically add `delta` to an integer bookkeeping counter and return the new value.
   * A single UPSERT (autocommit under SQLite's writer lock) — immune to the lost-update
   * a JS read-modify-write (`getMeta` → `+delta` → `setMeta`) suffers when two writers
   * race (e.g. the auto-distill spend rollup, #138 RC-004). A non-integer stored value
   * is treated as 0 before adding (defensive: `CAST` of garbage → 0 in SQLite).
   */
  incrMeta(key: string, delta: number): number {
    // Wrap the bound delta in CAST(? AS INTEGER): the driver binds a JS number as REAL,
    // so a bare CAST(? AS TEXT) would store '1.0' instead of '1'. Forcing INTEGER keeps
    // both the stored text and the arithmetic integer-typed.
    const row = this.conn()
      .prepare(
        `INSERT INTO kv_meta (key, value) VALUES (?, CAST(CAST(? AS INTEGER) AS TEXT))
         ON CONFLICT(key) DO UPDATE SET
           value = CAST(CAST(value AS INTEGER) + CAST(? AS INTEGER) AS TEXT)
         RETURNING CAST(value AS INTEGER) AS n`,
      )
      .get(key, delta, delta) as { n: number };
    return row.n;
  }

  /** Delete a bookkeeping value. No-op when the key is absent. */
  deleteMeta(key: string): void {
    this.conn().prepare('DELETE FROM kv_meta WHERE key = ?').run(key);
  }

  /**
   * List kv_meta keys sharing a literal `prefix`, ascending. Implemented as a
   * half-open range scan (`key >= prefix AND key < prefixSucc`) so it rides the
   * `kv_meta` PRIMARY KEY index instead of a full-table LIKE scan. Drives the
   * session→project binding cleanup (#50), which enumerates `session-project:*`.
   */
  listMetaKeys(prefix: string): string[] {
    const conn = this.conn();
    if (prefix.length === 0) {
      const all = conn.prepare('SELECT key FROM kv_meta ORDER BY key').all() as Array<{
        key: string;
      }>;
      return all.map((r) => r.key);
    }
    // Successor of `prefix`: bump the last code unit by one for the exclusive bound.
    const prefixSucc =
      prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const rows = conn
      .prepare('SELECT key FROM kv_meta WHERE key >= ? AND key < ? ORDER BY key')
      .all(prefix, prefixSucc) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  // --------------------------------------------------------- session → project

  /**
   * Upsert a session's project label (#50). UPDATEs the project of an existing
   * row, or creates the session when none exists for `externalId`. The UPDATE
   * branch is what lets an intentional decision override an auto-derived project
   * even after ingest already created the row with the cwd-derived slug (Risk #2).
   * Returns the row id. Deliberately separate from `createSession` so that
   * signature (high blast-radius) stays untouched.
   *
   * `meta` is carried only on the CREATE-on-miss path, so a binding that fires
   * before the first ingest still stores the `cwd` hint the normal create path
   * would have (Codex review on #50) — it never overwrites an existing row's meta.
   */
  setSessionProject(externalId: string, project: string, meta?: Record<string, unknown>): number {
    const existing = this.getSessionByExternalId(externalId);
    if (existing) {
      this.conn()
        .prepare('UPDATE sessions SET project = ? WHERE external_id = ?')
        .run(project, externalId);
      return existing.id;
    }
    return this.createSession(meta ? { externalId, project, meta } : { externalId, project });
  }

  // -------------------------------------------------------------------- counts

  /**
   * The highest observation `id` currently in the store, or 0 when empty. Because
   * ids are monotonic autoincrement, this is a cheap high-water mark — the
   * SessionStart staleness flag (#16) and the optimizer cursor (#21) use it to
   * count "new since last time" without scanning rows.
   */
  maxObservationId(): number {
    const row = this.conn().prepare('SELECT COALESCE(MAX(id), 0) AS m FROM observations').get() as {
      m: number;
    };
    return row.m;
  }

  /**
   * Count observations with `id > minIdExclusive`. A generic high-water count
   * (the UI `newSince` stat). NOTE: the SessionStart staleness banner no longer
   * uses this — #138 replaced the single "N since last optimization" cursor with the
   * two-signal model (`countUnconsolidatedRawTurns` + per-kind `countConsolidatedSince`).
   * Pure count — never mutates.
   */
  countObservationsSince(minIdExclusive: number): number {
    const row = this.conn()
      .prepare('SELECT COUNT(*) AS c FROM observations WHERE id > ?')
      .get(minIdExclusive) as { c: number };
    return row.c;
  }

  /**
   * Count raw turns whose session has NO `source='consolidate'` row — the #138
   * "needs consolidate" signal as a session-level anti-join (NOT an id cursor).
   * A global high-water cursor would strand raw turns of a session whose ids sit
   * below an already-consolidated session's id (Gate 0b C1); the anti-join can't.
   * Consolidate rows themselves are never counted as raw. Rides
   * `idx_observations_session_source`.
   */
  countUnconsolidatedRawTurns(): number {
    const row = this.conn()
      .prepare(
        `SELECT COUNT(*) AS c FROM observations o
         WHERE COALESCE(o.source, '') != 'consolidate'
           AND NOT EXISTS (
             SELECT 1 FROM observations c
             WHERE c.session_id = o.session_id AND c.source = 'consolidate'
           )`,
      )
      .get() as { c: number };
    return row.c;
  }

  /**
   * Count DISTINCT sessions that still need consolidate (same anti-join as
   * `countUnconsolidatedRawTurns`, by session). Drives the banner's "across M
   * session(s)" copy (#138).
   */
  countUnconsolidatedSessions(): number {
    const row = this.conn()
      .prepare(
        `SELECT COUNT(DISTINCT o.session_id) AS c FROM observations o
         WHERE COALESCE(o.source, '') != 'consolidate'
           AND NOT EXISTS (
             SELECT 1 FROM observations c
             WHERE c.session_id = o.session_id AND c.source = 'consolidate'
           )`,
      )
      .get() as { c: number };
    return row.c;
  }

  /**
   * Count consolidate observations of one `kind` in one `project` above the
   * per-kind/project optimize cursor (#138/#148). The "needs optimize" signal,
   * project-scoped via the same `session_id IN (SELECT id FROM sessions WHERE
   * project = …)` subquery as `buildObservationQuery`. Raw turns are excluded by
   * the `source='consolidate'` filter.
   */
  countConsolidatedSince(
    project: string,
    kind: 'lesson' | 'decision',
    minIdExclusive: number,
  ): number {
    const row = this.conn()
      .prepare(
        `SELECT COUNT(*) AS c FROM observations
         WHERE source = 'consolidate' AND kind = @kind AND id > @cursor
           AND session_id IN (SELECT id FROM sessions WHERE project = @project)`,
      )
      .get({ project, kind, cursor: minIdExclusive }) as { c: number };
    return row.c;
  }

  /**
   * The highest consolidate-obs id for one `kind` in one `project`, or 0 when
   * none. The advance target for that kind/project's optimize cursor (#138/#148)
   * — never a higher raw-turn id, never another project's id.
   */
  maxConsolidatedId(project: string, kind: 'lesson' | 'decision'): number {
    const row = this.conn()
      .prepare(
        `SELECT COALESCE(MAX(id), 0) AS m FROM observations
         WHERE source = 'consolidate' AND kind = @kind
           AND session_id IN (SELECT id FROM sessions WHERE project = @project)`,
      )
      .get({ project, kind }) as { m: number };
    return row.m;
  }

  /**
   * The ids of consolidate observations of one `kind` in one `project` above the
   * cursor (`S_kind` for the #138 partition advance). The keep-set partition
   * needs the FULL id list (a `--limit`-sliced survivor never appears in any
   * candidate's `evidenceIds`), so this is the source of truth for `S_kind`.
   */
  consolidatedIdsSince(
    project: string,
    kind: 'lesson' | 'decision',
    minIdExclusive: number,
  ): number[] {
    const rows = this.conn()
      .prepare(
        `SELECT id FROM observations
         WHERE source = 'consolidate' AND kind = @kind AND id > @cursor
           AND session_id IN (SELECT id FROM sessions WHERE project = @project)
         ORDER BY id ASC`,
      )
      .all({ project, kind, cursor: minIdExclusive }) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  /**
   * Count observations belonging to one session (#138 cadence-due gate, W2).
   * Rides `idx_observations_session`. Unknown id → 0.
   */
  countObservationsBySession(sessionId: number): number {
    const row = this.conn()
      .prepare('SELECT COUNT(*) AS c FROM observations WHERE session_id = ?')
      .get(sessionId) as { c: number };
    return row.c;
  }

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
