/**
 * Two-signal staleness heuristic (#16 / #138 / #148) — pure, count-only.
 *
 * The "live memory" loop ingests raw observations continuously (#15) but distils
 * them in TWO steps: `consolidate` (raw turns → durable lessons/decisions) and
 * `optimize` (durable obs → files). SessionStart surfaces two independent signals so
 * the agent begins each session aware of where memory is drifting:
 *
 *   1. **Needs consolidate** — a SESSION-LEVEL anti-join (raw turns whose session has
 *      no `source='consolidate'` row), NOT an id cursor (Gate 0b C1). A global
 *      high-water cursor would strand raw turns of a session sitting below an
 *      already-consolidated session's id; the anti-join can't.
 *   2. **Needs optimize** — TWO kind-aware, project-scoped cursors
 *      (`optimize:lesson:<slug>`, `optimize:decision:<slug>`). Lessons auto-clear
 *      under the cadence; decisions stay manual, so they keep their own cursor.
 *
 * This module ONLY counts and decides whether to flag; it never runs a distiller and
 * never advances a cursor (that is the optimizer's job, #21/#138).
 */

/**
 * kv_meta key for the per-kind, per-project optimize cursor (#138/#148). REPLACES
 * the single global `optimize:cursorObsId`, which conflated kinds (lessons auto-clear,
 * decisions stay manual) and was shared across projects (promotion is project-scoped
 * since #135). `<projectSlug>` is the SAME label `projectSlug` resolves a cwd to, so
 * cursor scoping and candidate-generation scoping match byte-for-byte.
 */
export function optimizeCursorKey(kind: 'lesson' | 'decision', projectSlug: string): string {
  return `optimize:${kind}:${projectSlug}`;
}

/**
 * Below this many pending raw turns we don't bother flagging — a session that
 * added a handful of turns isn't "stale" in a way worth nudging about.
 */
export const STALENESS_MIN_PENDING = 25;

/** Parse the stored cursor value defensively → a non-negative integer (0 on garbage/absent). */
export function parseCursor(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Inputs to the two-signal verdict (all project-scoped where noted). */
export interface TwoSignalInput {
  /** Raw turns whose session has no consolidate row (anti-join). */
  rawPending: number;
  /** Distinct sessions needing consolidate. */
  rawSessions: number;
  /** Consolidate lessons above the lesson cursor, this project. */
  lessonsPending: number;
  /** Consolidate decisions above the decision cursor, this project. */
  decisionsPending: number;
  /** Flag bar for raw-pending; defaults to STALENESS_MIN_PENDING. */
  threshold?: number;
  /** Whether an LLM is configured (drives banner copy: auto vs manual). */
  hasLlm: boolean;
}

/** The two-signal verdict surfaced to the SessionStart banner. */
export interface TwoSignalVerdict {
  rawPending: number;
  rawSessions: number;
  /** rawPending >= threshold. */
  rawFlagged: boolean;
  lessonsPending: number;
  decisionsPending: number;
  /** lessonsPending + decisionsPending. */
  consolidatedPending: number;
  /** consolidatedPending > 0 (independent of the raw threshold). */
  consolidatedFlagged: boolean;
  hasLlm: boolean;
}

/**
 * Decide the two-signal staleness from the pre-counted inputs (pure). Raw-pending
 * flags at the threshold; consolidated-pending flags whenever > 0 (any un-promoted
 * durable obs is worth a nudge, regardless of count). `hasLlm` passes through to
 * drive the banner's auto-vs-manual copy.
 */
export function evaluateTwoSignalStaleness(input: TwoSignalInput): TwoSignalVerdict {
  const threshold = input.threshold ?? STALENESS_MIN_PENDING;
  const consolidatedPending = input.lessonsPending + input.decisionsPending;
  return {
    rawPending: input.rawPending,
    rawSessions: input.rawSessions,
    rawFlagged: input.rawPending >= threshold,
    lessonsPending: input.lessonsPending,
    decisionsPending: input.decisionsPending,
    consolidatedPending,
    consolidatedFlagged: consolidatedPending > 0,
    hasLlm: input.hasLlm,
  };
}
