/**
 * Git helpers for the symbol indexer. All best-effort: a non-repo / missing git / error
 * yields undefined or []. execFileSync (no shell); the repo path is the only variable.
 */
import { execFileSync } from 'node:child_process';

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** Absolute repo toplevel for `cwd`, or undefined when not a git repo. */
export function repoRoot(cwd: string): string | undefined {
  return git(cwd, ['rev-parse', '--show-toplevel'])?.trim() || undefined;
}

/** HEAD commit sha, or undefined when unavailable (incl. an empty repo with no commits). */
export function headCommit(root: string): string | undefined {
  const out = git(root, ['rev-parse', 'HEAD']);
  return out === undefined ? undefined : out.trim();
}

/**
 * Tracked files (repo-relative). `undefined` when GIT FAILED (timeout/error); a real
 * empty result is `[]`. The distinction matters: the indexer must not stamp the index
 * fresh off a failed listing (F7-05) — `undefined` says "don't trust this", `[]` says
 * "genuinely no files".
 */
export function lsFiles(root: string): string[] | undefined {
  const out = git(root, ['ls-files']);
  return out === undefined ? undefined : out.split('\n').filter(Boolean);
}

/**
 * Repo-relative files changed between commits `a` and `b`. `undefined` when GIT FAILED;
 * `[]` is a real "no changes". The indexer relies on this distinction so a transient
 * `git diff` error never stamps `indexed_commit` over content it never indexed (F7-05).
 */
export function diffNames(root: string, a: string, b: string): string[] | undefined {
  const out = git(root, ['diff', '--name-only', a, b]);
  return out === undefined ? undefined : out.split('\n').filter(Boolean);
}

/**
 * Repo-relative dirty files (modified, added, untracked, rename destinations).
 * `undefined` when GIT FAILED; `[]` is a real "clean tree". The overlay reconciliation
 * (F7-06) must not treat a git error as "clean" and wipe the overlay.
 */
export function dirtyFiles(root: string): string[] | undefined {
  const out = git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (out === undefined) return undefined;
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    let p = line.slice(3); // strip the 2-char XY status + space
    const arrow = p.indexOf(' -> '); // renames/copies: `old -> new` → index the destination
    if (arrow >= 0) p = p.slice(arrow + 4);
    p = p.trim().replace(/^"|"$/g, ''); // unquote paths with spaces
    if (p) paths.push(p);
  }
  return paths;
}
