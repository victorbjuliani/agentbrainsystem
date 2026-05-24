/**
 * The freshness engine: keep the per-repo symbol store current with the working tree,
 * lazily + incrementally from git. Async (tree-sitter parse); call at async hook boundaries
 * BEFORE the sync provider reads. Never throws (best-effort ground truth).
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { diffNames, dirtyFiles, headCommit, lsFiles, repoRoot } from './git.js';
import { initParser, parseDefinitions } from './parser.js';
import { openSymbolStore, type SymbolStore } from './symbol-store.js';

const SUPPORTED = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py']);
const isSupported = (p: string) => SUPPORTED.has(extname(p));

/** Parse one repo-relative file (if it exists + supported) and upsert; else drop it. */
async function indexOne(store: SymbolStore, root: string, rel: string): Promise<void> {
  if (!isSupported(rel)) return;
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    store.deleteFile(rel);
    return;
  }
  try {
    const defs = await parseDefinitions(rel, readFileSync(abs, 'utf8'));
    if (defs) store.upsertFile(rel, defs);
  } catch {
    // unreadable / parse failure → leave prior entry (conservative)
  }
}

/**
 * Make the symbol index for the repo containing `cwd` reflect current code. Resolves
 * silently when `cwd` is not in a git repo. Idempotent and cheap in steady state.
 */
export async function refreshIndex(cwd: string): Promise<void> {
  const root = repoRoot(cwd);
  if (!root) return; // not a git repo → no native ground truth
  await initParser();
  const store = openSymbolStore(root);
  try {
    const head = headCommit(root); // undefined for an empty repo
    const indexed = store.getMeta('indexed_commit');

    if (head && head !== indexed) {
      if (!indexed) {
        for (const rel of lsFiles(root)) await indexOne(store, root, rel);
      } else {
        for (const rel of diffNames(root, indexed, head)) await indexOne(store, root, rel);
      }
      store.setMeta('indexed_commit', head);
    }

    // Working-tree overlay (always): reflect uncommitted edits/additions/deletions.
    for (const rel of dirtyFiles(root)) await indexOne(store, root, rel);
  } finally {
    store.close();
  }
}

/** Repo-relative path for an absolute (or already-relative) file under `root`. Realpaths both
 * sides first: git toplevel is the realpath (/private/var/... on macOS) while an Edit's file_path
 * may be the symlink form (/var/...); a literal prefix compare would miss. */
export function toRepoRelative(root: string, filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  let real = filePath;
  let realRoot = root;
  try {
    real = realpathSync(filePath);
  } catch {
    /* file may be deleted — keep the given path */
  }
  try {
    realRoot = realpathSync(root);
  } catch {
    /* keep */
  }
  const r = realRoot.endsWith('/') ? realRoot : `${realRoot}/`;
  return real.startsWith(r) ? real.slice(r.length) : real;
}
