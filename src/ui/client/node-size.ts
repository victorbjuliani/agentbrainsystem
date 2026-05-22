/**
 * Pure node-radius mapping (DESIGN §11). Extracted from render.ts so it is testable
 * under the `node` Vitest env (render.ts touches `window`/`force-graph` at import).
 * main.ts and the renderer both derive radius from here — one source of truth.
 */
import type { NodeType } from '../graph-types.js';

/**
 * Map a node's `sizeDriver` to a world radius with a gentle sqrt curve.
 *
 * Hierarchy (DESIGN §11):
 *   - `session` hubs grow with their obs count (`sizeDriver`, graph.ts:216).
 *   - `lesson`/`decision` are sized by CLASS, not by their driver: their `sizeDriver`
 *     is edge degree (graph.ts:306), NOT insight weight, so a large fixed base — not
 *     the driver — is what makes consolidated memory read médio→grande. A high-degree
 *     leaf can match them only at degree ≥ 6, which is a legitimate hub, so the
 *     apparent inversion below degree 6 is intentional (do not "fix" it).
 *   - `user`/`assistant`/`tool` leaves stay small with a wider degree spread, so a
 *     well-connected observation reads as a star rather than a uniform dot.
 *
 * The sqrt curve keeps hubs prominent without giant outliers (§11).
 */
export function radiusFor(type: NodeType, sizeDriver: number): number {
  const consolidated = type === 'lesson' || type === 'decision';
  const base = type === 'session' ? 5 : consolidated ? 8 : 2.6;
  const weight = type === 'session' ? 1.5 : consolidated ? 0.6 : 2.3;
  // Guard non-finite/negative drivers so a bad payload never yields NaN radius.
  const driver = Number.isFinite(sizeDriver) ? Math.max(0, sizeDriver) : 0;
  return base + Math.sqrt(driver) * weight;
}
