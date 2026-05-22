/**
 * Pure set-math for the type-filter pills (DESIGN §11). Kept DOM-free so the
 * isolate/restore/additive logic is testable under the `node` Vitest env without
 * jsdom. Both the container (main.ts) and the chrome (overlays.ts) consume the
 * SAME `presentTypes` here, so "which types are present" is computed once — the
 * canvas filter and the pill states can never drift.
 */
import type { GraphNode, NodeType } from '../graph-types.js';

/** The set of node types actually present in a payload (drives pill visibility). */
export function presentTypes(nodes: readonly GraphNode[]): Set<NodeType> {
  const present = new Set<NodeType>();
  for (const n of nodes) present.add(n.type);
  return present;
}

/**
 * Compute the next visible-types set from a pill click.
 *
 * - Plain click ISOLATES the clicked type (show only it). Clicking the type that
 *   is already isolated RESTORES all present types — a discoverable, reversible
 *   "focus then back" gesture.
 * - Modifier click (additive) keeps the legacy on/off toggle so 2–3 types can be
 *   combined.
 *
 * Guard: the result is never an all-empty/all-absent set (which `render.ts`
 * `isVisible` would paint as a blank canvas) — both branches fall back to all
 * present types instead.
 */
export function nextVisibleTypes(
  current: ReadonlySet<NodeType>,
  clicked: NodeType,
  present: ReadonlySet<NodeType>,
  additive: boolean,
): Set<NodeType> {
  if (additive) {
    const next = new Set(current);
    if (next.has(clicked)) next.delete(clicked);
    else next.add(clicked);
    // Never leave nothing on screen: if the toggle emptied the visible-and-present
    // set, revert to showing everything present.
    const anyVisiblePresent = [...next].some((t) => present.has(t));
    return anyVisiblePresent ? next : new Set(present);
  }
  // Plain click: clicking the already-isolated type restores all present; otherwise
  // isolate to just the clicked type.
  const isolatedToClicked = current.size === 1 && current.has(clicked);
  return isolatedToClicked ? new Set(present) : new Set<NodeType>([clicked]);
}
