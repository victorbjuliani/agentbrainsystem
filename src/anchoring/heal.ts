/**
 * Self-healing (issue #28) — the B layer's invalidation engine.
 *
 * A `verified` anchor can rot when the code moves under it. Healing re-resolves
 * each verified anchor against current ground truth and reacts:
 *
 *   - symbol still resolves at the same file  → keep verified (re-pin line/commit);
 *   - symbol resolves at a NEW file (rename/move) → re-anchor, stay verified;
 *   - symbol no longer resolves anywhere (remove) → mark `stale` (NEVER deleted);
 *   - file anchor whose file is gone → mark `stale`.
 *
 * Two entry points share `healOne`:
 *   - `healAnchors`     — a periodic reconciliation sweep over verified anchors.
 *   - `verifyOnRecall`  — the lazy path: heal only the anchors of facts about to
 *                         be used. Bounded by the hits passed; fail-open so the
 *                         per-prompt hot path never blocks (ADR-0004/0005).
 *
 * Fail-open everywhere: an unavailable provider heals nothing.
 */
import type { GroundTruthProvider } from '../ground-truth/index.js';
import type { FactAnchor, MemoryStore } from '../store/index.js';

/** Outcome of healing one anchor. */
type HealOutcome = 'ok' | 'reanchored' | 'staled';

/** Per-run healing tally. */
export interface HealResult {
  processed: number;
  /** Verified anchors still resolving (line/commit re-pinned). */
  ok: number;
  /** Anchors whose symbol moved to a new file (re-anchored, kept verified). */
  reanchored: number;
  /** Anchors whose target vanished (marked stale, not deleted). */
  staled: number;
}

const EMPTY: HealResult = { processed: 0, ok: 0, reanchored: 0, staled: 0 };

/** Re-resolve one verified anchor and apply the rename/remove decision. */
function healOne(
  store: MemoryStore,
  provider: GroundTruthProvider,
  anchor: FactAnchor,
): HealOutcome {
  if (anchor.anchorKind === 'symbol' && anchor.qualifiedName) {
    // Same-file first: cheapest and the common case.
    const here = provider.resolveSymbol(anchor.qualifiedName, { filePath: anchor.filePath });
    if (here) {
      store.updateAnchorState(anchor.id, 'verified', {
        line: here.line,
        commitSha: here.commitSha,
      });
      return 'ok';
    }
    // Moved? Resolve the symbol without the file hint (rename/relocation).
    const moved = provider.resolveSymbol(anchor.qualifiedName);
    if (moved) {
      store.reanchorAnchor(anchor.id, {
        filePath: moved.filePath,
        line: moved.line,
        commitSha: moved.commitSha,
      });
      return 'reanchored';
    }
    store.updateAnchorState(anchor.id, 'stale');
    return 'staled';
  }

  // File anchor: alive iff the file still resolves.
  if (provider.resolveFile(anchor.filePath)) {
    store.updateAnchorState(anchor.id, 'verified', {});
    return 'ok';
  }
  store.updateAnchorState(anchor.id, 'stale');
  return 'staled';
}

function tally(
  store: MemoryStore,
  provider: GroundTruthProvider,
  anchors: FactAnchor[],
): HealResult {
  const result: HealResult = { ...EMPTY };
  for (const anchor of anchors) {
    result.processed++;
    const outcome = healOne(store, provider, anchor);
    result[outcome]++;
  }
  return result;
}

/**
 * Reconciliation sweep: re-verify up to `limit` verified anchors. Fail-open when
 * ground truth is unavailable.
 */
export function healAnchors(
  store: MemoryStore,
  provider: GroundTruthProvider,
  options: { limit?: number } = {},
): HealResult {
  if (!provider.isAvailable()) return { ...EMPTY };
  return tally(store, provider, store.listAnchorsByState('verified', options.limit));
}

/**
 * Lazy verify-on-recall: heal only the verified anchors belonging to the given
 * observation ids (the facts about to be surfaced). Fail-open and cheap so the
 * recall hot path stays within budget.
 */
export function verifyOnRecall(
  store: MemoryStore,
  provider: GroundTruthProvider,
  observationIds: number[],
): HealResult {
  if (!provider.isAvailable()) return { ...EMPTY };
  const anchors: FactAnchor[] = [];
  for (const obsId of observationIds) {
    for (const a of store.getAnchorsForObservation(obsId)) {
      if (a.state === 'verified') anchors.push(a);
    }
  }
  return tally(store, provider, anchors);
}
