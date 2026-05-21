/**
 * CodeReviewGraphProvider — reads a per-repo code-review-graph SQLite DB
 * (`<repo>/.code-review-graph/graph.db`) read-only to resolve symbols/files.
 *
 * Fail-open everywhere: a missing DB, an unreadable file, or a query error all
 * collapse to "unavailable / not found" (null) rather than throwing — the
 * guard (#29) runs in a timeout-bounded hook that must never crash the agent.
 * Opening read-only (`mode=ro`) guarantees we never mutate ground truth.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { currentBranch } from './git.js';
import type { GroundTruthProvider, ResolvedSymbol } from './types.js';

const SYMBOL_KINDS = "('Function', 'Class', 'Test', 'Type')";

interface NodeRow {
  qualified_name: string;
  file_path: string;
  line_start: number | null;
}

export class CodeReviewGraphProvider implements GroundTruthProvider {
  private db: Database.Database | null = null;
  private commitSha: string | undefined;
  private opened = false;

  /** @param repoRoot absolute path to the repo whose `.code-review-graph/graph.db` to read. */
  constructor(private readonly repoRoot: string) {}

  private conn(): Database.Database | null {
    if (this.opened) return this.db;
    this.opened = true;
    const dbPath = join(this.repoRoot, '.code-review-graph', 'graph.db');
    if (!existsSync(dbPath)) return null;
    try {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.commitSha = this.readCommit(this.db);
    } catch {
      this.db = null;
    }
    return this.db;
  }

  /** Best-effort read of the commit the graph was built at (metadata table; optional). */
  private readCommit(db: Database.Database): string | undefined {
    try {
      const row = db
        .prepare(
          "SELECT value FROM metadata WHERE key IN ('commit', 'built_at_commit', 'commit_sha') LIMIT 1",
        )
        .get() as { value: string } | undefined;
      return row?.value;
    } catch {
      return undefined;
    }
  }

  isAvailable(): boolean {
    return this.conn() !== null;
  }

  resolveSymbol(
    name: string,
    opts: { filePath?: string; unique?: boolean } = {},
  ): ResolvedSymbol | null {
    const db = this.conn();
    if (!db) return null;
    try {
      const params: unknown[] = [name];
      let fileClause = '';
      if (opts.filePath) {
        fileClause = ' AND file_path = ?';
        params.push(opts.filePath);
      }
      // LIMIT 2 so we can detect ambiguity for the `unique` caller without
      // scanning every match.
      const rows = db
        .prepare(
          `SELECT qualified_name, file_path, line_start
           FROM nodes
           WHERE name = ? AND kind IN ${SYMBOL_KINDS}${fileClause}
           LIMIT 2`,
        )
        .all(...params) as NodeRow[];
      if (rows.length === 0) return null;
      // Ambiguous bare-name match: refuse rather than guess a homonym.
      if (opts.unique && rows.length > 1) return null;
      const row = rows[0] as NodeRow;
      return {
        qualifiedName: row.qualified_name,
        filePath: row.file_path,
        line: row.line_start ?? undefined,
        commitSha: this.commitSha,
      };
    } catch {
      return null;
    }
  }

  currentBranch(): string | undefined {
    return currentBranch(this.repoRoot);
  }

  resolveFile(filePath: string): ResolvedSymbol | null {
    const db = this.conn();
    if (!db) return null;
    try {
      const row = db
        .prepare("SELECT file_path FROM nodes WHERE kind = 'File' AND file_path = ? LIMIT 1")
        .get(filePath) as { file_path: string } | undefined;
      if (!row) return null;
      return { qualifiedName: row.file_path, filePath: row.file_path, commitSha: this.commitSha };
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
