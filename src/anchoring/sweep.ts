/**
 * Anchor verification sweep (issue #26) — the demand side of the E layer.
 *
 * Walks `claimed` anchors and asks the ground-truth provider whether each one
 * still resolves. A hit promotes the anchor to `verified`, pinning the
 * resolved `file:line@commit`; a miss leaves it `claimed` (unverifiable now —
 * never deleted, never auto-marked stale here; that is self-healing's job, #28).
 *
 * Runs out of the ingest hot-path (the seed step #25 only writes cheap claims),
 * so this can be timeout-/batch-bounded. Fail-open throughout: an unavailable
 * provider promotes nothing and the run is a clean no-op.
 */
import type { GroundTruthProvider } from '../ground-truth/index.js';
import type { MemoryStore } from '../store/index.js';

/** Per-run sweep tally. */
export interface SweepResult {
  /** Claimed anchors examined this run. */
  processed: number;
  /** Anchors promoted claimed → verified. */
  verified: number;
  /** Anchors left claimed because ground truth could not resolve them. */
  unresolved: number;
}

/** Options for one sweep pass. */
export interface SweepOptions {
  /** Max claimed anchors to examine this run (default: all). */
  limit?: number;
}

/**
 * Resolve `claimed` anchors against ground truth, promoting the ones that still
 * exist. Symbol anchors resolve by `qualifiedName` (disambiguated by file);
 * file anchors resolve by path. Returns the tally.
 */
export function sweepAnchors(
  store: MemoryStore,
  provider: GroundTruthProvider,
  options: SweepOptions = {},
): SweepResult {
  const result: SweepResult = { processed: 0, verified: 0, unresolved: 0 };

  // Fail-open: no ground truth → nothing is verifiable, clean no-op.
  if (!provider.isAvailable()) return result;

  const branch = provider.currentBranch();
  const claimed = store.listAnchorsByState('claimed', options.limit);
  for (const anchor of claimed) {
    result.processed++;
    const resolved =
      anchor.anchorKind === 'symbol' && anchor.qualifiedName
        ? provider.resolveSymbol(anchor.qualifiedName, { filePath: anchor.filePath })
        : provider.resolveFile(anchor.filePath);

    if (resolved) {
      store.updateAnchorState(anchor.id, 'verified', {
        commitSha: resolved.commitSha,
        line: resolved.line,
        branch,
      });
      result.verified++;
    } else {
      result.unresolved++;
    }
  }

  return result;
}
