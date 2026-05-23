/**
 * Pure anatomy→data mapping for the creature renderer (DESIGN.md §11).
 *
 * No WebGL, no DOM: deterministic geometry so it is unit-testable. This is the
 * substitute for the retired 2D force-graph geometry (`node-size`/`occlusion`)
 * called for by ADR-0015 — the WebGL paint layer itself is audited visually
 * (frontend-auditor), but the numbers that drive it live here and are tested.
 */

/**
 * Position of observation `index` (of `count` in its session) along the
 * tentacle, where 0 ≈ the bell and 1 ≈ the tip. Observations are spread evenly
 * by index (not by timestamp) so a burst ingested at the same instant reads as
 * a strand of beads instead of a single blob. A lone observation sits mid-tentacle.
 */
export function beadParam(index: number, count: number): number {
  if (count <= 1) return 0.5;
  return 0.05 + (index / (count - 1)) * 0.92;
}

/**
 * Radial angle (radians) of session tentacle `index` (of `count`) around the
 * bell base. A constant base offset keeps the first tentacle off the screen axis.
 */
export function tentacleAngle(index: number, count: number): number {
  return (index / count) * Math.PI * 2 + 0.4;
}

/**
 * Tentacle length: grows logarithmically with observation count (fuller sessions
 * hang lower) and is capped so a huge session never runs off-screen.
 */
export function tentacleLength(obsCount: number): number {
  return 3.8 + Math.min(4.2, Math.log2(obsCount + 1) * 1.05);
}

/**
 * Normalize a timestamp to [0,1] within [tMin,tMax] (1 = most recent). A
 * degenerate window (all observations at the same instant) reads as fresh (1).
 * Out-of-window timestamps clamp to the ends.
 */
export function recencyNorm(t: number, tMin: number, tMax: number): number {
  if (tMax <= tMin) return 1;
  const n = (t - tMin) / (tMax - tMin);
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
