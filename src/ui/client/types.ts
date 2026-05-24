/**
 * Client-local view types (issue #11). The wire shape lives in `../graph-types.js`
 * (the frozen contract); these augment it with the runtime fields force-graph
 * mutates (x/y/vx/vy) plus the per-node animation/derived state the renderer owns.
 *
 * Kept DOM-light so it typechecks under tsconfig.ui.json (Bundler/DOM).
 */
import type { GraphEdge, GraphNode, NodeType } from '../graph-types.js';

/**
 * A node as the renderer sees it. The creature renderer (ADR-0015) derives all of
 * its geometry from the wire fields (`type`/`sizeDriver`/`createdAt`/`sessionId`)
 * and owns layout internally, so no extra per-node state leaks into the view model
 * (the retired force-graph renderer added x/y + radius/phase/breathRate here).
 */
export type ViewNode = GraphNode;

/**
 * An edge in the view model. `source`/`target` are widened to allow a resolved
 * node object (a renderer may swap the wire string id for the node), with the rest
 * of GraphEdge — kind/weight — preserved.
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

/**
 * The scope the client currently asks the server to render. Lives here (not in
 * main.ts) so the pure `scopeToQuery` projection (scope.ts) is testable without
 * pulling the DOM/CSS-bound container module.
 */
export interface ScopeState {
  mode: ScopeMode;
  sessionId?: number;
  similarity: boolean;
  /** Store-wide project filter (topN mode only, #62-B). Undefined = all projects. */
  project?: string;
  /**
   * Active store-wide search (#35). When set, it drives an authoritative server
   * fetch (FTS) that reaches obs OUTSIDE the topN/session window, so it takes
   * precedence over `mode`/`sessionId` in the query string.
   */
  search?: string;
}

/** Taxonomy entry for legend / filter pills (DESIGN §4 / §11). */
export interface TypeMeta {
  type: NodeType;
  label: string;
  /** CSS var name carrying the hex (e.g. `--accent-user`). */
  cssVar: string;
}
