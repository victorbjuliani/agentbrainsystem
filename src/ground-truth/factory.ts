/**
 * Provider selection: abs's own native symbol index when `cwd` is in a git repo, else the
 * null adapter. The external code-review-graph dependency is retired — abs owns its ground
 * truth (offline/$0). Consumers only ever see the GroundTruthProvider port.
 *
 * `repoRoot` is a `git rev-parse` exec; this factory is called on the per-prompt recall hot
 * path (user-prompt-submit verifyOnRecall), so memoize by cwd for the lifetime of the
 * (short-lived hook) process — one exec per cwd, not per call.
 */
import { repoRoot } from '../index/git.js';
import { AbsIndexProvider } from './abs-index-provider.js';
import { NullGroundTruthProvider } from './null-provider.js';
import type { GroundTruthProvider } from './types.js';

const rootCache = new Map<string, string | undefined>();
function cachedRepoRoot(cwd: string): string | undefined {
  const cached = rootCache.get(cwd);
  if (cached !== undefined || rootCache.has(cwd)) return cached;
  const r = repoRoot(cwd);
  rootCache.set(cwd, r);
  return r;
}

export function createGroundTruthProvider(cwd: string | undefined): GroundTruthProvider {
  if (!cwd) return new NullGroundTruthProvider();
  const gitRoot = cachedRepoRoot(cwd);
  if (!gitRoot) return new NullGroundTruthProvider();
  return new AbsIndexProvider(gitRoot);
}
