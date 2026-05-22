/**
 * Contradiction-guard evaluation harness (issue #30) — the A layer's release
 * gate (O3). The guard is only worth shipping if it catches real duplication
 * (true positives) without crying wolf (false positives): a noisy guard trains
 * the user to ignore it. This measures both against a labelled set of actions.
 *
 * Gate (from the discovery): TP ≥ 30% on seeded bad cases AND FP < 1 alarm per
 * 10 benign actions. Below that, the guard stays warn-only (never block).
 */

import type { Memory } from '../memory.js';
import type { HookPayload } from './payload.js';
import { handlePreToolUse, type PreToolUseDeps } from './pre-tool-use.js';

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
async function fired(payload: HookPayload, deps?: PreToolUseDeps): Promise<boolean> {
  return (await handlePreToolUse(payload, deps ?? {})) !== undefined;
}

/**
 * Evaluate the guard over a labelled case set. `tpThreshold` defaults to 0.30
 * and `fpPerActionMax` to 0.1 (under 1 alarm / 10 actions) — the O3 gate.
 *
 * The O3 gate measures the BLOCK-eligible duplication lens. Pass an empty/no-
 * decision `memory` so the warn-only decision-surfacing lens (#48 Phase A) stays
 * silent and cannot perturb the duplication TP/FP measurement (it never blocks
 * and so does not need this gate to ship).
 */
export async function evaluateGuard(
  cases: GuardCase[],
  thresholds: { tpThreshold?: number; fpPerActionMax?: number } = {},
  deps?: { memory?: Memory },
): Promise<GuardEvalResult> {
  const tpThreshold = thresholds.tpThreshold ?? 0.3;
  const fpPerActionMax = thresholds.fpPerActionMax ?? 0.1;

  const bad = cases.filter((c) => c.shouldFire);
  const benign = cases.filter((c) => !c.shouldFire);
  const evalDeps: PreToolUseDeps = deps?.memory ? { memory: deps.memory } : {};
  const truePositives = (await Promise.all(bad.map((c) => fired(c.payload, evalDeps)))).filter(
    Boolean,
  ).length;
  const falsePositives = (await Promise.all(benign.map((c) => fired(c.payload, evalDeps)))).filter(
    Boolean,
  ).length;

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
