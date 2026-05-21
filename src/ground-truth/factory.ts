/**
 * Provider selection: a code-review-graph adapter when a graph DB is present
 * for the repo, the null adapter otherwise. Centralizing the choice here keeps
 * every consumer (sweep #26, self-healing #28, guard #29) graph-agnostic and
 * honours the offline/$0 default — no graph, no problem.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CodeReviewGraphProvider } from './graph-provider.js';
import { NullGroundTruthProvider } from './null-provider.js';
import type { GroundTruthProvider } from './types.js';

/**
 * Pick a ground-truth provider for `repoRoot`. Returns the graph-backed
 * provider only when `<repoRoot>/.code-review-graph/graph.db` exists; otherwise
 * the null provider (everything degrades to `claimed`/warn-only).
 */
export function createGroundTruthProvider(repoRoot: string | undefined): GroundTruthProvider {
  if (!repoRoot) return new NullGroundTruthProvider();
  const dbPath = join(repoRoot, '.code-review-graph', 'graph.db');
  if (!existsSync(dbPath)) return new NullGroundTruthProvider();
  return new CodeReviewGraphProvider(repoRoot);
}
