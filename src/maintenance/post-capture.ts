/**
 * Post-capture maintenance (#107) — the one place the "after ANY capture, promote
 * claimed→verified anchors against ground truth" step lives.
 *
 * The freshness/trust layer (claimed→verified→stale seals) is a core differentiator,
 * but the sweep used to run ONLY inside the SessionEnd handler. Claude/Codex/Gemini/
 * Copilot all route their capture event to `abs hook session-end`, so they were
 * covered — but OpenCode captures through its own `abs opencode-capture` CLI path
 * (no SessionEnd), so its anchors stayed `claimed` forever. Lifting the step into a
 * shared helper lets every capture path call the SAME maintenance.
 *
 * Invariants:
 *   - OUT of the interactive hot path — only capture paths call this (never recall).
 *   - Fail-open (ADR-0004): not-a-git-repo, an unavailable provider, or a sweep error
 *     is a clean no-op and NEVER undoes the ingest that already succeeded.
 *   - Idempotent: `sweepAnchors` re-checks claimed/verified anchors, so a second run
 *     (or a SessionEnd that already swept) does no harm — no double-sweep hazard.
 *   - ADR-0009: stale anchors are never deleted here.
 */
import { sweepAnchors } from '../anchoring/index.js';
import {
  createGroundTruthProvider,
  type GroundTruthProvider,
  refreshIndex,
} from '../ground-truth/index.js';
import type { MemoryStore } from '../store/index.js';

/** Max claimed anchors a single sweep promotes — bounds the out-of-hot-path cost. */
export const SWEEP_LIMIT = 200;

export interface PostCaptureDeps {
  /** Injection seam for tests — defaults to the cwd-rooted ground-truth provider. */
  groundTruth?: GroundTruthProvider;
}

/**
 * Run the post-capture anchor sweep against ground truth rooted at `cwd`. Fully
 * fail-open: any error (refresh, provider construction, sweep) is swallowed so the
 * preceding capture/ingest is never undone.
 */
export async function runPostCaptureMaintenance(
  store: MemoryStore,
  cwd: string,
  deps: PostCaptureDeps = {},
): Promise<void> {
  try {
    // Make the native symbol index current first so the sweep verifies against
    // up-to-date ground truth (skipped when a test injects its own provider).
    if (!deps.groundTruth) await refreshIndex(cwd);
    const provider = deps.groundTruth ?? createGroundTruthProvider(cwd);
    try {
      sweepAnchors(store, provider, { limit: SWEEP_LIMIT });
    } finally {
      if (!deps.groundTruth) provider.close();
    }
  } catch {
    // fail-open — the capture already persisted; maintenance is best-effort.
  }
}
