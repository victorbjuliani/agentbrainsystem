/**
 * Per-repo symbol index store: <ABS_HOME>/index/<projectSlug(repoRoot)>.db. Separate from
 * memory.db — code-derived data with its own (rebuildable, never-committed) lifecycle.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { projectSlug } from '../optimize/targets.js';
import type { Definition } from './parser.js';

export interface SymbolHit {
  filePath: string;
  name: string;
  kind: string;
  line: number;
}

/** One parsed file ready to apply: `defs` to upsert, or `null` to delete the file. */
export interface FileOp {
  filePath: string;
  defs: Definition[] | null;
}

export interface SymbolStore {
  /** Absolute path of the backing `<slug>.db` — used to key the per-repo refresh lock (#106). */
  readonly dbPath: string;
  upsertFile(filePath: string, defs: Definition[]): void;
  deleteFile(filePath: string): void;
  /**
   * Apply a batch of already-parsed file ops in ONE transaction (#106). When `stamp`
   * is given, `indexed_commit` is set inside the SAME transaction as the upserts/
   * deletes — so the commit can never be recorded ahead of the state it describes
   * (a crash rolls back both). Pass `stamp` only when the batch is the COMPLETE diff
   * for that commit; omit it for the working-tree overlay or a budget-truncated build.
   */
  applyBatch(ops: FileOp[], stamp?: string): void;
  queryByName(name: string, filePath?: string): SymbolHit[];
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  close(): void;
}

const SCHEMA_VERSION = '1';

interface SymbolRow {
  file_path: string;
  name: string;
  kind: string;
  line_start: number;
}

export function openSymbolStore(repoRoot: string): SymbolStore {
  const dir = join(loadConfig().dataDir, 'index');
  mkdirSync(dir, { recursive: true });
  // Realpath the root so a symlink path (/var/...) and its realpath (/private/var/... on macOS)
  // map to the SAME index db: refreshIndex uses the git toplevel (realpath) while a caller may
  // pass a symlinked cwd.
  let canonical = repoRoot;
  try {
    canonical = realpathSync(repoRoot);
  } catch {
    /* path may not exist (tests use synthetic roots) — fall back to the given path */
  }
  const dbPath = join(dir, `${projectSlug(canonical)}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    `CREATE TABLE IF NOT EXISTS symbols (
       file_path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line_start INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
     CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
     CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  );
  const cur = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  if (!cur) {
    db.prepare("INSERT INTO meta (key,value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
  }

  const insDef = db.prepare(
    'INSERT INTO symbols (file_path, name, kind, line_start) VALUES (?, ?, ?, ?)',
  );
  const delFile = db.prepare('DELETE FROM symbols WHERE file_path = ?');

  const setMetaStmt = db.prepare(
    'INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  );
  const applyOne = (op: FileOp): void => {
    delFile.run(op.filePath);
    if (op.defs) for (const d of op.defs) insDef.run(op.filePath, d.name, d.kind, d.line);
  };

  return {
    dbPath,
    upsertFile(filePath, defs): void {
      const tx = db.transaction(() => {
        delFile.run(filePath);
        for (const d of defs) insDef.run(filePath, d.name, d.kind, d.line);
      });
      tx();
    },
    deleteFile(filePath): void {
      delFile.run(filePath);
    },
    applyBatch(ops, stamp): void {
      const tx = db.transaction(() => {
        for (const op of ops) applyOne(op);
        if (stamp !== undefined) setMetaStmt.run('indexed_commit', stamp);
      });
      tx();
    },
    queryByName(name, filePath): SymbolHit[] {
      const rows = (
        filePath
          ? db
              .prepare(
                'SELECT file_path, name, kind, line_start FROM symbols WHERE name=? AND file_path=?',
              )
              .all(name, filePath)
          : db
              .prepare('SELECT file_path, name, kind, line_start FROM symbols WHERE name=?')
              .all(name)
      ) as SymbolRow[];
      return rows.map((r) => ({
        filePath: r.file_path,
        name: r.name,
        kind: r.kind,
        line: r.line_start,
      }));
    },
    getMeta(key): string | undefined {
      const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as
        | { value: string }
        | undefined;
      return r?.value;
    },
    setMeta(key, value): void {
      db.prepare(
        'INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(key, value);
    },
    close(): void {
      db.close();
    },
  };
}
