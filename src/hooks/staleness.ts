/**
 * Pending-optimization staleness heuristic (#16) — pure, count-only.
 *
 * The "live memory" loop ingests raw observations continuously (#15) but distills
 * them into durable lessons only when an optimizer runs (#21, not this issue). To
 * tell the user their memory is drifting from "raw" toward "distilled", SessionStart
 * surfaces a staleness flag: how many observations have landed SINCE the last
 * optimization.
 *
 * The cursor is a kv_meta high-water mark — the max observation id at the last
 * optimize run. Counting `id > cursor` is O(1)-ish (indexed) and needs no new
 * column. This module ONLY counts and decides whether to flag; it never runs an
 * optimizer and never advances the cursor (that is the optimizer's job, #21).
 */

/** kv_meta key holding the observation id high-water mark at the last optimize run. */
export const OPTIMIZE_CURSOR_KEY = 'optimize:cursorObsId';

/**
 * Below this many pending observations we don't bother flagging — a session that
 * added a handful of turns isn't "stale" in a way worth nudging about.
 */
export const STALENESS_MIN_PENDING = 25;

export interface StalenessVerdict {
  /** Observation id cursor read from kv_meta (0 when never optimized). */
  cursor: number;
  /** Observations with id > cursor. */
  pending: number;
  /** True when `pending >= STALENESS_MIN_PENDING`. */
  flagged: boolean;
}

/** Parse the stored cursor value defensively → a non-negative integer (0 on garbage/absent). */
export function parseCursor(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Decide staleness from the raw cursor value and the current pending count.
 * `threshold` is injectable for tests; defaults to `STALENESS_MIN_PENDING`.
 */
export function evaluateStaleness(
  cursorRaw: string | null,
  pending: number,
  threshold: number = STALENESS_MIN_PENDING,
): StalenessVerdict {
  const cursor = parseCursor(cursorRaw);
  return { cursor, pending, flagged: pending >= threshold };
}
