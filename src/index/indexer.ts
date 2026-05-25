/**
 * The freshness engine: keep the per-repo symbol store current with the working tree,
 * lazily + incrementally from git. Async (tree-sitter parse); call at async hook boundaries
 * BEFORE the sync provider reads. Never throws (best-effort ground truth).
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { diffNames, dirtyFiles, headCommit, lsFiles, repoRoot } from './git.js';
import { initParser, parseDefinitions } from './parser.js';
import { type FileOp, openSymbolStore, type SymbolStore } from './symbol-store.js';

const SUPPORTED = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py']);
const isSupported = (p: string) => SUPPORTED.has(extname(p));

/** A refresh never runs longer than this; a lock older than this is from a crashed holder. */
const LOCK_TTL_MS = 30_000;

/** Outcome of {@link refreshIndex}. */
export interface RefreshResult {
  /**
   * The committed index reflects the current HEAD, so the duplication lens may read it
   * safely. `false` when a cold build was budget-truncated, or skipped because another
   * session holds the per-repo refresh lock and the local index is not yet at HEAD —
   * interactive callers should then SKIP the lens rather than read a half-built index
   * (#106; a partial read only ever under-blocks, but skipping is the documented choice).
   */
  ready: boolean;
}

/**
 * Single-flight per repo (RC-004): take an exclusive lock keyed on the `<slug>.db` path
 * so two sessions in the same repo never rebuild concurrently. Returns a release fn, or
 * `null` when another live refresh holds it (the caller reuses the existing index). A
 * lock older than the TTL is from a crashed holder and is stolen once.
 */
function acquireIndexLock(dbPath: string): (() => void) | null {
  const lockPath = `${dbPath}.refresh.lock`;
  const take = (): (() => void) => {
    const fd = openSync(lockPath, 'wx'); // exclusive create — throws if held
    writeSync(fd, `${process.pid} ${Date.now()}`);
    closeSync(fd);
    return () => {
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone — nothing to release */
      }
    };
  };
  try {
    return take();
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_TTL_MS) {
        unlinkSync(lockPath); // stale (crashed holder) → steal once
        return take();
      }
    } catch {
      /* lost the steal race, or stat/take failed — treat as held */
    }
    return null;
  }
}

/** True when the committed index already matches HEAD (an empty repo is trivially current). */
function isAtHead(store: SymbolStore, root: string): boolean {
  const head = headCommit(root);
  return !head || store.getMeta('indexed_commit') === head;
}

/**
 * Parse repo-relative files into apply-ready ops, stopping early when `overBudget` trips
 * (the interactive time-box). `complete:false` means it stopped short. The async parse
 * (tree-sitter) is separated from the write so the caller applies the batch in one txn.
 */
async function parseFiles(
  root: string,
  rels: Iterable<string>,
  overBudget: () => boolean,
): Promise<{ ops: FileOp[]; complete: boolean }> {
  const ops: FileOp[] = [];
  for (const rel of rels) {
    if (overBudget()) return { ops, complete: false };
    if (!isSupported(rel)) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      ops.push({ filePath: rel, defs: null }); // deleted → drop its symbols
      continue;
    }
    try {
      const defs = await parseDefinitions(rel, readFileSync(abs, 'utf8'));
      if (defs) ops.push({ filePath: rel, defs });
    } catch {
      // unreadable / parse failure → leave the prior entry (conservative)
    }
  }
  return { ops, complete: true };
}

/**
 * Make the symbol index for the repo containing `cwd` reflect current code. Resolves
 * silently when `cwd` is not in a git repo. Idempotent and cheap in steady state.
 *
 * `budgetMs` time-boxes the build on the interactive (guard) path: when it trips, the
 * partial work is applied WITHOUT stamping `indexed_commit`, so the next unbudgeted
 * refresh (SessionEnd / post-capture) finishes it. Single-flight per repo, and the
 * commit stamp is atomic with the upserts (#106).
 */
export async function refreshIndex(
  cwd: string,
  opts: { budgetMs?: number } = {},
): Promise<RefreshResult> {
  const root = repoRoot(cwd);
  if (!root) return { ready: false }; // not a git repo → no native ground truth
  await initParser();
  const store = openSymbolStore(root);
  const release = acquireIndexLock(store.dbPath);
  if (!release) {
    // Another session is refreshing this repo — don't double-parse. Reuse the existing
    // index; it is lens-ready only if already at HEAD.
    const ready = isAtHead(store, root);
    store.close();
    return { ready };
  }
  try {
    const deadline = opts.budgetMs !== undefined ? Date.now() + opts.budgetMs : undefined;
    const overBudget = (): boolean => deadline !== undefined && Date.now() >= deadline;

    const head = headCommit(root); // undefined for an empty repo
    const indexed = store.getMeta('indexed_commit');
    let commitComplete = true;
    if (head && head !== indexed) {
      const files = indexed ? diffNames(root, indexed, head) : lsFiles(root);
      const parsed = await parseFiles(root, files, overBudget);
      commitComplete = parsed.complete;
      // Stamp the commit ONLY when the full diff was applied — atomic with the upserts,
      // so `indexed_commit` can never run ahead of the indexed state.
      store.applyBatch(parsed.ops, parsed.complete ? head : undefined);
    }

    // Working-tree overlay (always): reflect uncommitted edits/additions/deletions. It
    // never stamps a commit, so a truncated overlay just re-applies on the next refresh.
    const dirty = await parseFiles(root, dirtyFiles(root), overBudget);
    store.applyBatch(dirty.ops);

    const ready = !head || (commitComplete && store.getMeta('indexed_commit') === head);
    return { ready };
  } finally {
    release();
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
