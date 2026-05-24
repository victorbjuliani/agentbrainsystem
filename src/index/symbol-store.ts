/**
 * Per-repo symbol index store: <ABS_HOME>/index/<projectSlug(repoRoot)>.db. Separate from
 * memory.db — code-derived data with its own (rebuildable, never-committed) lifecycle.
 */
import { mkdirSync } from 'node:fs';
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

export interface SymbolStore {
  upsertFile(filePath: string, defs: Definition[]): void;
  deleteFile(filePath: string): void;
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
  const db = new Database(join(dir, `${projectSlug(repoRoot)}.db`));
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

  return {
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
