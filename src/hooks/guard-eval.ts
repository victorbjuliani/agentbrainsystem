/**
 * Contradiction-guard evaluation harness (issue #30) — the A layer's release
 * gate (O3). The guard is only worth shipping if it catches real duplication
 * (true positives) without crying wolf (false positives): a noisy guard trains
 * the user to ignore it. This measures both against a labelled set of actions.
 *
 * Gate (from the discovery): TP ≥ 30% on seeded bad cases AND FP < 1 alarm per
 * 10 benign actions. Below that, the guard stays warn-only (never block).
 */

import type { HookPayload } from './payload.js';
import { handlePreToolUse } from './pre-tool-use.js';

/** One labelled action: a PreToolUse payload and whether the guard SHOULD fire. */
export interface GuardCase {
  name: string;
  payload: HookPayload;
  /** True when this action is a genuine contradiction the guard ought to flag. */
  shouldFire: boolean;
}

/** Metrics produced by an evaluation run. */
export interface GuardEvalResult {
  badCases: number;
  benignCases: number;
  truePositives: number;
  falsePositives: number;
  /** Fraction of bad cases flagged (recall). */
  tpRate: number;
  /** False alarms per benign action. */
  fpPerAction: number;
  /** Whether both release thresholds hold. */
  passesGate: boolean;
}

/** Did the guard fire (any non-undefined decision) for this payload? */
function fired(payload: HookPayload): boolean {
  return handlePreToolUse(payload) !== undefined;
}

/**
 * Evaluate the guard over a labelled case set. `tpThreshold` defaults to 0.30
 * and `fpPerActionMax` to 0.1 (under 1 alarm / 10 actions) — the O3 gate.
 */
export function evaluateGuard(
  cases: GuardCase[],
  thresholds: { tpThreshold?: number; fpPerActionMax?: number } = {},
): GuardEvalResult {
  const tpThreshold = thresholds.tpThreshold ?? 0.3;
  const fpPerActionMax = thresholds.fpPerActionMax ?? 0.1;

  const bad = cases.filter((c) => c.shouldFire);
  const benign = cases.filter((c) => !c.shouldFire);
  const truePositives = bad.filter((c) => fired(c.payload)).length;
  const falsePositives = benign.filter((c) => fired(c.payload)).length;

  const tpRate = bad.length === 0 ? 0 : truePositives / bad.length;
  const fpPerAction = benign.length === 0 ? 0 : falsePositives / benign.length;

  return {
    badCases: bad.length,
    benignCases: benign.length,
    truePositives,
    falsePositives,
    tpRate,
    fpPerAction,
    passesGate: tpRate >= tpThreshold && fpPerAction < fpPerActionMax,
  };
}
