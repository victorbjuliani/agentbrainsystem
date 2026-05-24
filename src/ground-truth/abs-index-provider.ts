/**
 * GroundTruthProvider backed by abs's own symbol index (no external tool). SYNC reads over
 * the per-repo SQLite — the async parse happened in `refreshIndex` at the hook boundary.
 *
 * Golden rule: never a FALSE stale. A symbol missing from a file whose language we do not
 * parse, when the file still exists, resolves file-level (keeps verified/claimed); only a
 * genuine absence in a PARSED codebase returns null (which self-heal turns into stale).
 */
import { existsSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { toRepoRelative } from '../index/indexer.js';
import { openSymbolStore, type SymbolStore } from '../index/symbol-store.js';
import { currentBranch as gitBranch } from './git.js';
import type { GroundTruthProvider, ResolvedSymbol } from './types.js';

const SUPPORTED = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py']);

export class AbsIndexProvider implements GroundTruthProvider {
  private store: SymbolStore | null = null;
  private opened = false;
  constructor(private readonly root: string) {}

  private conn(): SymbolStore | null {
    if (this.opened) return this.store;
    this.opened = true;
    try {
      this.store = openSymbolStore(this.root);
    } catch {
      this.store = null;
    }
    return this.store;
  }
  private absOf(rel: string): string {
    return isAbsolute(rel) ? rel : join(this.root, rel);
  }
  private commit(): string | undefined {
    return this.conn()?.getMeta('indexed_commit') || undefined;
  }

  isAvailable(): boolean {
    return this.conn() !== null;
  }

  resolveSymbol(
    name: string,
    opts: { filePath?: string; unique?: boolean } = {},
  ): ResolvedSymbol | null {
    const store = this.conn();
    if (!store) return null;
    const commitSha = this.commit();

    if (opts.filePath) {
      const rel = toRepoRelative(this.root, opts.filePath);
      const sameFile = store.queryByName(name, rel);
      if (sameFile.length > 0) {
        return {
          qualifiedName: name,
          filePath: this.absOf(rel),
          line: sameFile[0]?.line,
          commitSha,
        };
      }
      // Conservative: a file we cannot parse (unsupported language) that still exists must never
      // be staled — resolve it file-level so the anchor stays verified/claimed.
      if (!SUPPORTED.has(extname(rel)) && existsSync(opts.filePath)) {
        return { qualifiedName: name, filePath: opts.filePath, commitSha };
      }
      // else: parsed file, symbol genuinely absent here → try a cross-file move.
    }

    const anywhere = store.queryByName(name);
    if (anywhere.length === 0) return null;
    if (opts.unique && anywhere.length > 1) return null;
    const hit = anywhere[0];
    if (!hit) return null;
    return { qualifiedName: name, filePath: this.absOf(hit.filePath), line: hit.line, commitSha };
  }

  resolveFile(filePath: string): ResolvedSymbol | null {
    const abs = isAbsolute(filePath) ? filePath : join(this.root, filePath);
    if (!existsSync(abs)) return null;
    return { qualifiedName: abs, filePath: abs, commitSha: this.commit() };
  }

  currentBranch(): string | undefined {
    return gitBranch(this.root);
  }

  close(): void {
    if (this.store) {
      this.store.close();
      this.store = null;
    }
  }
}
