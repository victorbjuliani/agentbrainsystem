/**
 * Tiny git helper for branch scoping (FR-C1, #31). Best-effort and never throws:
 * a non-repo, missing git, or detached HEAD all yield `undefined`, so callers
 * stay offline-safe. Uses `execFileSync` (no shell) with fixed arguments — the
 * repo path is the only variable and is never interpolated into a command line.
 */
import { execFileSync } from 'node:child_process';

/** Current branch of `repoRoot`, or undefined when unavailable/detached. */
export function currentBranch(repoRoot: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // Detached HEAD reports 'HEAD' — treat as unknown rather than a branch name.
    return out && out !== 'HEAD' ? out : undefined;
  } catch {
    return undefined;
  }
}
