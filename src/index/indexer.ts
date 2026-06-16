/**
 * The freshness engine: keep the per-repo symbol store current with the working tree,
 * lazily + incrementally from git. Async (tree-sitter parse); call at async hook boundaries
 * BEFORE the sync provider reads. Never throws (best-effort ground truth).
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { commitExists, diffNames, dirtyFiles, headCommit, lsFiles, repoRoot } from './git.js';
import { initParser, parseDefinitions } from './parser.js';
import { type FileOp, openSymbolStore, type SymbolStore } from './symbol-store.js';

const SUPPORTED = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py']);
const isSupported = (p: string) => SUPPORTED.has(extname(p));

/**
 * A lock not heartbeated within the TTL is from a crashed holder and may be stolen. A LIVE
 * holder beats every {@link LOCK_HEARTBEAT_MS} (well under the TTL) so a legitimately long
 * refresh on a big repo is NEVER mistaken for dead and stolen (Codex review on #106).
 */
const LOCK_TTL_MS = 30_000;
const LOCK_HEARTBEAT_MS = 5_000;

/**
 * Files larger than this are SKIPPED on the budgeted (interactive) path — a single huge
 * file's tree-sitter parse cannot be interrupted mid-await, so it could blow the budget
 * (Codex review on #106). They are deferred to the next unbudgeted refresh, which marks
 * the build incomplete so the commit is not stamped until they are indexed.
 */
const INTERACTIVE_MAX_FILE_BYTES = 256 * 1024;

/** A held refresh lock: `heartbeat()` keeps it fresh during a long build; `release()` frees it. */
interface IndexLock {
  heartbeat(): void;
  release(): void;
}

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

/** Does the refresh lockfile currently carry OUR ownership token? */
function ownsIndexLock(lockPath: string, token: string): boolean {
  try {
    return (JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: string }).token === token;
  } catch {
    return false;
  }
}

/**
 * Single-flight per repo (RC-004): take an exclusive lock keyed on the `<slug>.db` path
 * so two sessions in the same repo never rebuild concurrently. Returns the lock, or `null`
 * when another LIVE refresh holds it (the caller reuses the existing index). A lock whose
 * mtime is older than the TTL belongs to a crashed holder — a live holder heartbeats, so
 * it never goes stale — and is stolen once.
 *
 * F1-03: ownership is token-checked and the steal is ATOMIC — a faithful sibling of
 * `acquireCadenceLock` (#149). The previous version (a) released with an UNCONDITIONAL
 * `unlinkSync`, so a process that stalled past the TTL would delete a PEER's fresh lock
 * (double-owner), and (b) stole via `stat`-then-`unlink`, a TOCTOU where two processes
 * both see "stale" and both unlink+create. Both are fixed by an ownership token and a
 * rename-then-recreate steal that serializes in the kernel.
 */
export function acquireIndexLock(dbPath: string): IndexLock | null {
  const lockPath = `${dbPath}.refresh.lock`;
  // Filesystem-safe separator (Codex review on PR #168): the token is embedded in the
  // `.dead-${token}` steal-scratch FILENAME, and `:` is invalid on Windows (treated as an
  // alternate data stream), so a colon would make the steal `rename` fail and leave a
  // crashed lock in place. pid + randomUUID() (digits/hex/hyphens) are all path-safe.
  const token = `${process.pid}-${randomUUID()}`;
  const payload = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() });
  const make = (): IndexLock => {
    let lastBeat = Date.now();
    return {
      heartbeat(): void {
        const now = Date.now();
        if (now - lastBeat < LOCK_HEARTBEAT_MS) return; // throttle — avoid per-file fs writes
        try {
          if (ownsIndexLock(lockPath, token)) {
            utimesSync(lockPath, new Date(), new Date()); // bump mtime → "still alive"
            lastBeat = now;
          }
        } catch {
          /* lock vanished (stolen/cleared) — release() will no-op */
        }
      },
      release(): void {
        // Only remove the lockfile if WE still own it — an unconditional unlink can
        // delete a peer's lock that legitimately stole ours after a stall.
        try {
          if (ownsIndexLock(lockPath, token)) unlinkSync(lockPath);
        } catch {
          /* already gone — nothing to release */
        }
      },
    };
  };
  try {
    writeFileSync(lockPath, payload, { flag: 'wx' }); // atomic exclusive create — EEXIST if held
    return make();
  } catch {
    // Held. Steal ONLY if stale (dead holder), and ATOMICALLY: rename(2) over the same
    // source serializes in the kernel, so only one racer moves the stale inode; the
    // loser's rename throws (source gone) and stays unacquired. Never a plain unlink.
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_TTL_MS) {
        const dead = `${lockPath}.dead-${token}`;
        try {
          renameSync(lockPath, dead); // only one concurrent steal wins this move
          writeFileSync(lockPath, payload, { flag: 'wx' }); // recreate exclusively
        } catch {
          rmSync(dead, { force: true }); // lost mid-steal → cleanup, stay unacquired
          return null;
        }
        // Past this point the lock is OURS (rename+wx both succeeded). Removing the
        // dead scratch file is best-effort cleanup that must NEVER discard a real
        // acquisition — so it is guarded separately, not grouped with the steal above.
        try {
          rmSync(dead, { force: true });
        } catch {
          /* orphaned scratch — ages out, harmless */
        }
        return make();
      }
    } catch {
      /* lost the steal race, or stat failed — treat as held */
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
 * Meta key holding the JSON list of files the working-tree overlay last touched. On the
 * next refresh, any file in this set that is no longer dirty is reconciled back to its
 * committed/reverted state, so a dirty→clean transition leaves no stale overlay symbols
 * (F7-06).
 */
const OVERLAY_FILES_KEY = 'overlay_files';

/** The previous overlay file set (the files made dirty at the last refresh), or []. */
function readOverlaySet(store: SymbolStore): string[] {
  const raw = store.getMeta(OVERLAY_FILES_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

interface ParseControl {
  /** Trips when the interactive time budget is spent — stop before the next file. */
  overBudget: () => boolean;
  /** Bump the refresh lock so a long build is not mistaken for a dead holder. */
  heartbeat: () => void;
  /** When set (budgeted/interactive path), skip files larger than this many bytes. */
  maxFileBytes?: number;
}

/**
 * Parse repo-relative files into apply-ready ops, stopping early when `overBudget` trips
 * (the interactive time-box). `complete:false` means it stopped short OR skipped a too-big
 * file on the budgeted path — either way the caller must not stamp the commit. The async
 * parse (tree-sitter) is separated from the write so the caller applies the batch in one txn.
 */
async function parseFiles(
  root: string,
  rels: Iterable<string>,
  ctrl: ParseControl,
): Promise<{ ops: FileOp[]; complete: boolean }> {
  const ops: FileOp[] = [];
  let complete = true;
  for (const rel of rels) {
    if (ctrl.overBudget()) return { ops, complete: false };
    ctrl.heartbeat();
    if (!isSupported(rel)) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      ops.push({ filePath: rel, defs: null }); // deleted → drop its symbols
      continue;
    }
    // A single huge file's parse can't be interrupted mid-await, so on the budgeted path
    // skip it (defer to the unbudgeted refresh) rather than risk blowing the budget.
    if (ctrl.maxFileBytes !== undefined) {
      try {
        if (statSync(abs).size > ctrl.maxFileBytes) {
          complete = false; // deferred → build is not complete, don't stamp the commit
          continue;
        }
      } catch {
        /* stat failed — fall through and let the read/parse handle it */
      }
    }
    try {
      const defs = await parseDefinitions(rel, readFileSync(abs, 'utf8'));
      if (defs) ops.push({ filePath: rel, defs });
    } catch {
      // unreadable / parse failure → leave the prior entry (conservative)
    }
  }
  return { ops, complete };
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
  const lock = acquireIndexLock(store.dbPath);
  if (!lock) {
    // Another session is refreshing this repo — don't double-parse. Reuse the existing
    // index; it is lens-ready only if already at HEAD.
    const ready = isAtHead(store, root);
    store.close();
    return { ready };
  }
  try {
    const deadline = opts.budgetMs !== undefined ? Date.now() + opts.budgetMs : undefined;
    const ctrl: ParseControl = {
      overBudget: (): boolean => deadline !== undefined && Date.now() >= deadline,
      heartbeat: lock.heartbeat,
      // Skip oversized files only on the budgeted (interactive) path.
      ...(opts.budgetMs !== undefined ? { maxFileBytes: INTERACTIVE_MAX_FILE_BYTES } : {}),
    };

    const head = headCommit(root); // undefined for an empty repo
    let indexed = store.getMeta('indexed_commit');
    // F7-05 follow-up (Codex review on PR #170): a stored base commit that no longer
    // exists — repo re-cloned at the same path, or the commit pruned/rebased away —
    // makes `git diff <indexed> HEAD` fail PERMANENTLY (status 128, bad object), not
    // transiently. Treat it as a cold start (full re-list) so the index can recover,
    // instead of retrying an impossible diff forever and never becoming ready.
    if (indexed && head && indexed !== head && !commitExists(root, indexed)) {
      indexed = undefined;
    }
    let commitComplete = true;
    if (head && head !== indexed) {
      const files = indexed ? diffNames(root, indexed, head) : lsFiles(root);
      if (files === undefined) {
        // F7-05: git failed (timeout/error) — `undefined`, NOT an empty diff. Do NOT
        // stamp `indexed_commit` over content we never indexed (false-fresh). Leave the
        // stamp where it is and report not-ready; the next refresh retries the diff.
        commitComplete = false;
      } else {
        const parsed = await parseFiles(root, files, ctrl);
        commitComplete = parsed.complete;
        // Stamp the commit ONLY when the full diff was applied — atomic with the upserts,
        // so `indexed_commit` can never run ahead of the indexed state.
        store.applyBatch(parsed.ops, parsed.complete ? head : undefined);
      }
    }

    // Working-tree overlay: reflect uncommitted edits/additions/deletions, and RECONCILE
    // files that were dirty last time but are clean now (F7-06) — a dirty→clean revert
    // must not leave the overlay's stale symbols behind. Never stamps a commit, so a
    // truncated overlay just re-applies on the next refresh.
    const currentDirty = dirtyFiles(root);
    if (currentDirty !== undefined) {
      // git succeeded (`[]` = genuinely clean). A git FAILURE returns undefined → skip
      // overlay work entirely rather than mistake an error for "clean" and wipe symbols.
      const prevOverlay = readOverlaySet(store);
      const stale = prevOverlay.filter((f) => !currentDirty.includes(f));
      // Re-parse stale files from their now-clean disk state (committed/reverted), or
      // drop them if deleted — parseFiles emits a null-defs drop op for a missing file.
      const reconciled = await parseFiles(root, stale, ctrl);
      const dirty = await parseFiles(root, currentDirty, ctrl);
      store.applyBatch([...reconciled.ops, ...dirty.ops]);
      // Remember the new overlay set. If reconciliation was budget-truncated, keep the
      // un-finished stale files so they are retried next time instead of leaving residue.
      const nextOverlay = reconciled.complete
        ? currentDirty
        : [...new Set([...currentDirty, ...stale])];
      store.setMeta(OVERLAY_FILES_KEY, JSON.stringify(nextOverlay));
    }

    const ready = !head || (commitComplete && store.getMeta('indexed_commit') === head);
    return { ready };
  } finally {
    lock.release();
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
