/**
 * `buildGraph` (issue #11) — the pure, read-only projection of the memory store
 * into the wire `GraphData` the UI renders.
 *
 * Design constraints baked in here:
 *   - READ-ONLY: only the store's read methods are called; no write method is
 *     reachable from this module or anything it imports.
 *   - BOUNDED: hard module-level caps clamp every traversal. We NEVER call an
 *     uncapped `listObservations`/`listSessions` — a 100k-observation store must
 *     still produce a small, renderable graph.
 *   - DETERMINISTIC default scope: "latest" = most recently ACTIVE session
 *     (`listSessionsByActivity`), resolving the Gate-1 finding that ingest
 *     wall-clock (`sessions.created_at`) is the wrong ordering key.
 *   - SIMILARITY uses STORED vectors only (`getVector` + `knn`). No embedder, no
 *     query embedding — the UI never triggers a model load.
 */
import type { MemoryStore, Observation, Session } from '../store/index.js';
import {
  GRAPH_CONTRACT_VERSION,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type GraphQuery,
  type GraphScope,
  type NodeType,
} from './graph-types.js';

/** Max nodes (sessions + observations) we will ever emit. */
export const NODE_CAP = 600;
/** Max edges (containment + similarity) we will ever emit. */
export const EDGE_CAP = 1500;
/** Max sessions considered in topN mode. */
export const SESSION_CAP = 200;
/** Neighbours requested per observation for similarity (excludes self). */
export const SIMILARITY_K = 4;
/** Label content is truncated to keep the payload light. */
const LABEL_MAX = 80;

/** Kinds that map straight to a node type; anything else falls back to `tool`. */
const KNOWN_KINDS: ReadonlySet<NodeType> = new Set<NodeType>([
  'user',
  'assistant',
  'tool',
  'decision',
  'lesson',
]);

function sessionNodeId(sessionId: number): string {
  return `s:${sessionId}`;
}

function obsNodeId(obsId: number): string {
  return `o:${obsId}`;
}

function truncate(text: string): string {
  return text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1)}…`;
}

/** Map an observation's free-text `kind` onto the node taxonomy, never crashing. */
function nodeTypeForKind(kind: string): NodeType {
  return KNOWN_KINDS.has(kind as NodeType) ? (kind as NodeType) : 'tool';
}

function sessionLabel(session: Session): string {
  return session.project ?? session.externalId;
}

/**
 * Build the read-only graph projection for the given query. Pure: same store +
 * query → same output. Never mutates the store.
 */
export function buildGraph(store: MemoryStore, query: GraphQuery): GraphData {
  const counts = store.counts();
  const totals = { totalSessions: counts.sessions, totalObservations: counts.observations };
  const wantSimilarity = query.similarity === true;

  // Node budget: clamp the requested limit into (0, NODE_CAP].
  const requested = query.limit !== undefined && query.limit > 0 ? query.limit : NODE_CAP;
  const nodeBudget = Math.min(requested, NODE_CAP);

  // ---- Resolve scope + the observations in view (capped) --------------------
  let mode: GraphScope['mode'];
  let sessions: Session[];
  let observations: Observation[];
  let truncated = false;

  if (query.topN !== undefined) {
    mode = 'topN';
    // Most-recent observations store-wide. We fetch the newest `obsBudget` rows
    // by id (order:'desc' → highest ids = newest), then REVERSE so the rendered
    // window stays chronological ascending. The rendered set is always the
    // obsBudget MOST RECENT observations — never the oldest. obsBudget is bound
    // to nodeBudget, leaving room for the session hubs that derive from them.
    const obsBudget = Math.min(query.topN, nodeBudget);
    const newestFirst = store.listObservations({ limit: obsBudget, order: 'desc' });
    observations = newestFirst.reverse(); // chronological ascending within the window
    if (totals.totalObservations > observations.length) truncated = true;
    // Derive the sessions these observations belong to (capped).
    const sessionIds = new Set<number>();
    for (const o of observations) sessionIds.add(o.sessionId);
    sessions = [];
    for (const id of sessionIds) {
      if (sessions.length >= SESSION_CAP) {
        truncated = true;
        break;
      }
      const s = store.getSession(id);
      if (s) sessions.push(s);
    }
  } else {
    mode = 'session';
    let focus: Session | undefined;
    if (query.session !== undefined) {
      focus = store.getSession(query.session) ?? undefined;
    } else {
      // Default scope: the most recently ACTIVE session. GUARD the [0] access.
      const top = store.listSessionsByActivity(1);
      focus = top.length > 0 ? top[0] : undefined;
    }
    if (!focus) {
      return emptyGraph(query, totals, wantSimilarity, nodeBudget);
    }
    sessions = [focus];
    // Reserve one slot for the session hub itself.
    const obsBudget = Math.max(0, nodeBudget - 1);
    const obs = store.listObservations({ sessionId: focus.id, limit: obsBudget + 1 });
    if (obs.length > obsBudget) {
      observations = obs.slice(0, obsBudget);
      truncated = true;
    } else {
      observations = obs;
    }
  }

  if (sessions.length === 0 && observations.length === 0) {
    return emptyGraph(query, totals, wantSimilarity, nodeBudget);
  }

  // ---- Nodes ----------------------------------------------------------------
  const nodes: GraphNode[] = [];
  const obsCountBySession = new Map<number, number>();
  for (const o of observations) {
    obsCountBySession.set(o.sessionId, (obsCountBySession.get(o.sessionId) ?? 0) + 1);
  }

  const includedSessionIds = new Set<number>();
  for (const s of sessions) {
    if (nodes.length >= NODE_CAP) {
      truncated = true;
      break;
    }
    nodes.push({
      id: sessionNodeId(s.id),
      type: 'session',
      label: sessionLabel(s),
      sizeDriver: obsCountBySession.get(s.id) ?? 0,
      createdAt: s.createdAt,
    });
    includedSessionIds.add(s.id);
  }

  // Degree accumulator drives observation node size.
  const degree = new Map<string, number>();
  const includedObsIds = new Set<number>();
  const renderedObs: Observation[] = [];
  for (const o of observations) {
    if (nodes.length >= NODE_CAP) {
      truncated = true;
      break;
    }
    // Skip observations whose session hub did not make the cut (keeps edges valid).
    if (!includedSessionIds.has(o.sessionId)) {
      truncated = true;
      continue;
    }
    const id = obsNodeId(o.id);
    nodes.push({
      id,
      type: nodeTypeForKind(o.kind),
      label: truncate(o.content),
      sizeDriver: 0, // filled from degree once edges are known
      createdAt: o.createdAt,
      sessionId: sessionNodeId(o.sessionId),
    });
    includedObsIds.add(o.id);
    renderedObs.push(o);
  }

  // ---- Edges ----------------------------------------------------------------
  const edges: GraphEdge[] = [];

  // Containment: session → observation.
  for (const o of renderedObs) {
    if (edges.length >= EDGE_CAP) {
      truncated = true;
      break;
    }
    const sId = sessionNodeId(o.sessionId);
    const oId = obsNodeId(o.id);
    edges.push({ source: sId, target: oId, kind: 'containment', weight: 1 });
    degree.set(sId, (degree.get(sId) ?? 0) + 1);
    degree.set(oId, (degree.get(oId) ?? 0) + 1);
  }

  // Similarity: observation ↔ observation, from STORED vectors, deduped + capped.
  if (wantSimilarity) {
    const seen = new Set<string>();
    for (const o of renderedObs) {
      if (edges.length >= EDGE_CAP) {
        truncated = true;
        break;
      }
      const vec = store.getVector(o.id);
      if (!vec) continue;
      const hits = store.knn(vec, SIMILARITY_K + 1);
      for (const hit of hits) {
        if (hit.id === o.id) continue; // skip self
        if (!includedObsIds.has(hit.id)) continue; // only edges between rendered nodes
        const a = obsNodeId(o.id);
        const b = obsNodeId(hit.id);
        // Dedupe symmetric pairs (a↔b == b↔a).
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (edges.length >= EDGE_CAP) {
          truncated = true;
          break;
        }
        // Normalize distance → weight in [0,1] (closer = heavier). Distances from
        // sqlite-vec on L2-normalized vectors fall roughly in [0,2].
        const weight = Math.max(0, Math.min(1, 1 - hit.distance / 2));
        edges.push({ source: a, target: b, kind: 'similarity', weight });
        degree.set(a, (degree.get(a) ?? 0) + 1);
        degree.set(b, (degree.get(b) ?? 0) + 1);
      }
    }
  }

  // Fill observation sizeDriver from final degree.
  for (const node of nodes) {
    if (node.type !== 'session') {
      node.sizeDriver = degree.get(node.id) ?? 0;
    }
  }

  const scope: GraphScope = {
    mode,
    sessionId: mode === 'session' ? sessions[0]?.id : undefined,
    limit: nodeBudget,
    nodeCap: NODE_CAP,
    edgeCap: EDGE_CAP,
    similarity: wantSimilarity,
  };

  return {
    version: GRAPH_CONTRACT_VERSION,
    scope,
    nodes,
    edges,
    meta: {
      truncated,
      totalSessions: totals.totalSessions,
      totalObservations: totals.totalObservations,
      renderedNodes: nodes.length,
      emptyStore: totals.totalSessions === 0 && totals.totalObservations === 0,
    },
  };
}

/** A valid, empty GraphData payload — store is empty or the focus session is gone. */
function emptyGraph(
  query: GraphQuery,
  totals: { totalSessions: number; totalObservations: number },
  similarity: boolean,
  nodeBudget: number,
): GraphData {
  return {
    version: GRAPH_CONTRACT_VERSION,
    scope: {
      mode: query.topN !== undefined ? 'topN' : 'session',
      sessionId: query.session,
      limit: nodeBudget,
      nodeCap: NODE_CAP,
      edgeCap: EDGE_CAP,
      similarity,
    },
    nodes: [],
    edges: [],
    meta: {
      truncated: false,
      totalSessions: totals.totalSessions,
      totalObservations: totals.totalObservations,
      renderedNodes: 0,
      emptyStore: totals.totalSessions === 0 && totals.totalObservations === 0,
    },
  };
}
