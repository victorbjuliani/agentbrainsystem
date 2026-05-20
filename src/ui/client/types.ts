/**
 * Client-local view types (issue #11). The wire shape lives in `../graph-types.js`
 * (the frozen contract); these augment it with the runtime fields force-graph
 * mutates (x/y/vx/vy) plus the per-node animation/derived state the renderer owns.
 *
 * Kept DOM-light so it typechecks under tsconfig.ui.json (Bundler/DOM).
 */
import type { GraphEdge, GraphNode, NodeType } from '../graph-types.js';

/** A node as force-graph sees it: our data + the layout fields it writes in place. */
export interface ViewNode extends GraphNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
  /** Cached canvas radius (world units), derived from sizeDriver. */
  radius: number;
  /** Per-node phase offset (0..2π) so breathing is DESYNCHRONIZED (DESIGN §9 #2). */
  phase: number;
  /** Per-node breathing speed jitter so the pulse never reads as a metronome. */
  breathRate: number;
}

/**
 * An edge as force-graph sees it. force-graph rewrites `source`/`target` in place
 * from the wire string ids to the resolved node objects once the layout runs, so
 * we widen those two fields (the rest of GraphEdge — kind/weight — is preserved).
 */
export interface ViewEdge extends Omit<GraphEdge, 'source' | 'target'> {
  source: string | ViewNode;
  target: string | ViewNode;
}

export interface ViewGraph {
  nodes: ViewNode[];
  links: ViewEdge[];
}

export type Theme = 'dark' | 'light';

/** Scope mode the UI currently requests (mirrors GraphScope['mode']). */
export type ScopeMode = 'session' | 'topN';

/** Taxonomy entry for legend / filter pills (DESIGN §4 / §11). */
export interface TypeMeta {
  type: NodeType;
  label: string;
  /** CSS var name carrying the hex (e.g. `--accent-user`). */
  cssVar: string;
  /** Reserved types (lesson/decision) render as "pós-#12", never empty slots. */
  reserved: boolean;
}
