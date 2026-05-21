/**
 * Recall freshness annotation (issue #27) — the user-visible payoff of the E
 * layer. Each recalled fact is labelled by how well it still matches ground
 * truth, so the agent knows what to trust:
 *
 *   - `verified` — at least one anchor resolved to current code (file:line@commit).
 *   - `claimed`  — anchored but unverified (no graph, or not yet swept).
 *   - `stale`    — at least one anchor no longer resolves: a trust WARNING.
 *   - (none)     — no code anchors at all: a conversational fact, neutral.
 *
 * Precedence is worst-wins for the warning value: any `stale` anchor makes the
 * fact `stale` (the agent should be cautious), else any `verified` wins over
 * `claimed`. Stale facts are also demoted in ranking — they stay recallable
 * (never deleted) but sink below trustworthy ones.
 *
 * This lives outside the recall hot path (`recall.ts`): the FTS fast path stays
 * untouched; annotation is an explicit, cheap post-step the hook opts into.
 */
import type { AnchorState, MemoryStore } from '../store/index.js';
import type { RecallHit } from './recall.js';

/** Collapse an observation's anchors into one freshness state (worst-wins). */
function foldState(states: AnchorState[]): AnchorState | undefined {
  if (states.length === 0) return undefined;
  if (states.includes('stale')) return 'stale';
  if (states.includes('verified')) return 'verified';
  return 'claimed';
}

/**
 * Attach `anchorState` (and, when `currentBranch` is supplied, `crossBranch`) to
 * each hit from its observation's anchors, then reorder so `stale` facts sink to
 * the bottom (stable otherwise). Pure w.r.t. the store (reads only). Returns a
 * new array; inputs are not mutated.
 *
 * `crossBranch` (FR-C1, #31): set when an anchor was verified on a branch other
 * than the current one — the fact may not hold here. Facts with no recorded
 * branch (or no current branch) are never flagged.
 */
export function annotateFreshness(
  store: MemoryStore,
  hits: RecallHit[],
  currentBranch?: string,
): RecallHit[] {
  const annotated = hits.map((hit) => {
    const anchors = store.getAnchorsForObservation(hit.observation.id);
    const anchorState = foldState(anchors.map((a) => a.state));
    const crossBranch =
      currentBranch !== undefined &&
      anchors.some((a) => a.branch !== undefined && a.branch !== currentBranch);
    const next: RecallHit = { ...hit };
    if (anchorState) next.anchorState = anchorState;
    if (crossBranch) next.crossBranch = true;
    return next;
  });
  // Demote stale to the end while preserving relative order (stable partition).
  const fresh = annotated.filter((h) => h.anchorState !== 'stale');
  const stale = annotated.filter((h) => h.anchorState === 'stale');
  return [...fresh, ...stale];
}

/** A compact freshness tag for a recall bullet, or '' for a conversational fact. */
export function freshnessTag(state: AnchorState | undefined): string {
  switch (state) {
    case 'verified':
      return ' ✓verified';
    case 'claimed':
      return ' ~claimed';
    case 'stale':
      return ' ⚠stale';
    default:
      return '';
  }
}
