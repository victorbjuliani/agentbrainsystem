/**
 * Provider selection: a code-review-graph adapter when a graph DB is present
 * for the repo, the null adapter otherwise. Centralizing the choice here keeps
 * every consumer (sweep #26, self-healing #28, guard #29) graph-agnostic and
 * honours the offline/$0 default — no graph, no problem.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CodeReviewGraphProvider } from './graph-provider.js';
import { NullGroundTruthProvider } from './null-provider.js';
import type { GroundTruthProvider } from './types.js';

/**
 * Walk up from `start` (inclusive) looking for a directory that holds
 * `.code-review-graph/graph.db`. Returns the first such directory, or undefined.
 * This is why running from a subdirectory (monorepos, `cwd` deep in the tree)
 * still finds the graph at the repo root instead of silently degrading.
 */
function findGraphRoot(start: string): string | undefined {
  let dir = start;
  // Stop at the filesystem root (dirname of '/' is '/').
  for (;;) {
    if (existsSync(join(dir, '.code-review-graph', 'graph.db'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Pick a ground-truth provider for `repoRoot`. Searches `repoRoot` and its
 * ancestors for `.code-review-graph/graph.db`; uses the graph-backed provider
 * rooted at wherever it is found, else the null provider (everything degrades
 * to `claimed`/warn-only).
 */
export function createGroundTruthProvider(repoRoot: string | undefined): GroundTruthProvider {
  if (!repoRoot) return new NullGroundTruthProvider();
  const graphRoot = findGraphRoot(repoRoot);
  if (!graphRoot) return new NullGroundTruthProvider();
  return new CodeReviewGraphProvider(graphRoot);
}
