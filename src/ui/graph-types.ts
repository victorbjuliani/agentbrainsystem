/**
 * The graph contract (issue #11) — the single shared shape the backend
 * `buildGraph` produces and the browser client consumes over `GET /api/graph`.
 *
 * This file is intentionally DOM-free and Node-free: type-only declarations plus
 * one runtime const (the contract version). It MUST typecheck under BOTH
 * `tsconfig.json` (the Node/NodeNext build) and `tsconfig.ui.json` (the
 * DOM/Bundler client build) so the client and the server can never drift.
 *
 * `GRAPH_CONTRACT_VERSION` mirrors the role `EXPORT_VERSION` plays for the
 * portable artifact (#8): the client asserts it on every payload, so a breaking
 * change to the wire shape is caught loudly rather than silently mis-rendered.
 */

/** Bump when the wire shape of `GraphData` changes incompatibly. */
export const GRAPH_CONTRACT_VERSION = 1;

/**
 * Node taxonomy — aligned to the real `observation.kind` enum plus the synthetic
 * `session` hub (see docs/DESIGN.md §4 / §11). `decision` / `lesson` are reserved
 * (populated post-#12); the backend never crashes on an unknown kind — it falls
 * back to `tool` (see graph.ts).
 */
export type NodeType = 'session' | 'user' | 'assistant' | 'tool' | 'decision' | 'lesson';

/** A rendered node. `id` is namespaced: `s:<sessionId>` or `o:<observationId>`. */
export interface GraphNode {
  /** `s:<id>` for a session hub, `o:<id>` for an observation. */
  id: string;
  type: NodeType;
  /** Display label: session project/externalId, or truncated observation content. */
  label: string;
  /** Drives node size on the canvas: obs-count for a session, degree for an observation. */
  sizeDriver: number;
  /** ISO timestamp (session.createdAt or observation.createdAt). */
  createdAt: string;
  /** For observation nodes: the owning session node id (`s:<id>`). */
  sessionId?: string;
}

/** An edge between two node ids. */
export interface GraphEdge {
  /** Source node id (`s:<id>` | `o:<id>`). */
  source: string;
  /** Target node id (`s:<id>` | `o:<id>`). */
  target: string;
  /** `containment` = session→observation; `similarity` = observation↔observation (KNN). */
  kind: 'containment' | 'similarity';
  /** Containment edges weight 1; similarity edges carry a normalized [0,1] weight. */
  weight: number;
}

/** The resolved scope the backend actually rendered (after clamping to caps). */
export interface GraphScope {
  /**
   * `session` = one session's observations; `topN` = most-recent observations
   * store-wide; `search` = FTS matches store-wide (#35). Additive: an old client
   * that never sends `search` never sees this mode, so the wire shape stays
   * backward-compatible and GRAPH_CONTRACT_VERSION does not bump.
   */
  mode: 'session' | 'topN' | 'search';
  /** Present in `session` mode: the session whose subgraph was rendered. */
  sessionId?: number;
  /** Node budget actually applied (clamped to NODE_CAP). */
  limit: number;
  /** Hard node cap the backend enforces. */
  nodeCap: number;
  /** Hard edge cap the backend enforces. */
  edgeCap: number;
  /** Whether similarity edges were computed. */
  similarity: boolean;
}

/** Render-time metadata for the client (banners, truncation notices, empty state). */
export interface GraphMeta {
  /** True if any cap clipped nodes or edges. */
  truncated: boolean;
  totalSessions: number;
  totalObservations: number;
  renderedNodes: number;
  /** True when the store holds no sessions/observations at all. */
  emptyStore: boolean;
}

/** The full payload returned by `GET /api/graph`. */
export interface GraphData {
  version: typeof GRAPH_CONTRACT_VERSION;
  scope: GraphScope;
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: GraphMeta;
}

/** Parsed query knobs accepted by `buildGraph` (and the `/api/graph` query string). */
export interface GraphQuery {
  /** Focus a specific session id (`session` mode). */
  session?: number;
  /** Switch to `topN` mode: most-recent observations store-wide. */
  topN?: number;
  /** Requested node budget; clamped to NODE_CAP by the backend. */
  limit?: number;
  /** Compute similarity edges from stored vectors. */
  similarity?: boolean;
  /**
   * Free-text search (#35). When present and non-empty, switches to `search` mode:
   * the backend resolves matches store-wide via FTS (`toFtsQuery` → `searchFts`),
   * so a query reaches observations OUTSIDE the recency/scope window. Takes
   * precedence over `session`/`topN`.
   */
  search?: string;
}
