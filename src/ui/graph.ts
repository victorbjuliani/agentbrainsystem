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
 *   - SEARCH (#35) reuses the FTS keyword index (`toFtsQuery` → `searchFts`). FTS
 *     is keyword-only and embedder-free, so search ALSO never triggers a model load.
 *   - PINNING (#35): the durable `consolidate` output (`lesson`/`decision`) is
 *     forced into view regardless of recency/scope so it is never below the cap.
 */
import { toFtsQuery } from '../recall/index.js';
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
/** Max FTS hits resolved in `search` mode (#35); aligned to the node cap. */
export const SEARCH_CAP = NODE_CAP;
/** Max consolidated observations pinned into view per request (#35). */
export const PIN_CAP = 150;
/** The durable `consolidate` kinds we always pin into view (#35). */
export const PIN_KINDS: readonly string[] = ['lesson', 'decision'];
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
  // Store-wide project list for the picker — independent of the rendered window, so
  // the client can offer projects outside the current topN/search scope (#62-B).
  const projects = store.listProjects();

  // Node budget: clamp the requested limit into (0, NODE_CAP].
  const requested = query.limit !== undefined && query.limit > 0 ? query.limit : NODE_CAP;
  const nodeBudget = Math.min(requested, NODE_CAP);

  // ---- Resolve scope + the observations in view (capped) --------------------
  let mode: GraphScope['mode'];
  let sessions: Session[];
  let observations: Observation[];
  let truncated = false;

  const searchText = query.search?.trim();
  if (searchText) {
    // SEARCH mode (#35): FTS matches store-wide — reaches obs OUTSIDE the recency
    // window. Takes precedence over topN/session. Embedder-free (keyword index).
    mode = 'search';
    const resolved = resolveSearch(store, searchText);
    sessions = resolved.sessions;
    observations = resolved.observations;
    truncated = resolved.truncated;
  } else if (query.topN !== undefined) {
    mode = 'topN';
    // Most-recent observations store-wide. We fetch the newest `obsBudget` rows
    // by id (order:'desc' → highest ids = newest), then REVERSE so the rendered
    // window stays chronological ascending. The rendered set is always the
    // obsBudget MOST RECENT observations — never the oldest. obsBudget is bound
    // to nodeBudget, leaving room for the session hubs that derive from them.
    const obsBudget = Math.min(query.topN, nodeBudget);
    // Opt-in project filter: scope the recency window to one project's sessions.
    const newestFirst = store.listObservations({
      limit: obsBudget,
      order: 'desc',
      project: query.project,
    });
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
      return emptyGraph(mode, query, totals, wantSimilarity, nodeBudget, projects);
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

  // PIN consolidated types into view (#35). The durable `consolidate` output
  // (lesson/decision) is the highest-value memory but, being written last (highest
  // ids) and sparsely connected, it falls below the recency/degree cut in both
  // topN and session scope. We prepend the newest pins so they render FIRST — the
  // NODE_CAP guard below then drops the lowest-priority (scope) tail, not the pins.
  // NOT applied in search mode: a search defines its own result set explicitly.
  if (mode !== 'search') {
    // Scope pins to the project ONLY in topN mode — there the project picker drives
    // the window, so unscoped pins would leak other projects' lesson/decision (#129).
    // Session mode ignores `project` for its own window (see above), so its pins must
    // too: a `?session=X&project=Y` request must keep the intentional cross-session
    // pin surfacing (#35), not silently filter it. Gate by mode (Codex review).
    const pinProject = mode === 'topN' ? query.project : undefined;
    const merged = mergePinnedConsolidated(store, observations, sessions, nodeBudget, pinProject);
    observations = merged.observations;
    sessions = merged.sessions;
  }

  if (sessions.length === 0 && observations.length === 0) {
    return emptyGraph(mode, query, totals, wantSimilarity, nodeBudget, projects);
  }

  // ---- Nodes ----------------------------------------------------------------
  const nodes: GraphNode[] = [];
  const obsCountBySession = new Map<number, number>();
  for (const o of observations) {
    obsCountBySession.set(o.sessionId, (obsCountBySession.get(o.sessionId) ?? 0) + 1);
  }

  // Emit nodes by walking observations in PRIORITY order (pins lead `observations`),
  // adding each obs's session hub lazily right before its first observation. Hubs
  // are never emitted ahead of their observations, so a small `nodeBudget` spread
  // across many sessions can't fill up with hubs and starve the matched/pinned obs
  // (#42 P2). Each step is charged its full cost (obs + hub when the hub is new), so
  // we never half-commit an obs whose hub wouldn't fit, keeping containment edges
  // valid and the `scope.limit` contract honest.
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const includedSessionIds = new Set<number>();
  const degree = new Map<string, number>();
  const includedObsIds = new Set<number>();
  const renderedObs: Observation[] = [];
  for (const o of observations) {
    const session = sessionById.get(o.sessionId);
    if (!session) {
      truncated = true;
      continue; // session outside our resolved set — skip rather than orphan the obs
    }
    const needsHub = !includedSessionIds.has(o.sessionId);
    const cost = needsHub ? 2 : 1; // the obs, plus its session hub when not yet emitted
    if (nodes.length + cost > nodeBudget) {
      truncated = true;
      break;
    }
    if (needsHub) {
      nodes.push({
        id: sessionNodeId(session.id),
        type: 'session',
        label: sessionLabel(session),
        sizeDriver: obsCountBySession.get(session.id) ?? 0,
        createdAt: session.createdAt,
      });
      includedSessionIds.add(session.id);
    }
    nodes.push({
      id: obsNodeId(o.id),
      type: nodeTypeForKind(o.kind),
      label: truncate(o.content),
      sizeDriver: 0, // filled from degree once edges are known
      createdAt: o.createdAt,
      sessionId: sessionNodeId(o.sessionId),
    });
    includedObsIds.add(o.id);
    renderedObs.push(o);
  }

  // A session with NO observations in the set (e.g. a brand-new empty session in
  // session mode) still gets its hub, but only with leftover budget — observations
  // were served first, so this never starves them. Sessions that DID have obs but
  // lost the budget race are intentionally not shown as bare hubs.
  for (const s of sessions) {
    if (includedSessionIds.has(s.id) || (obsCountBySession.get(s.id) ?? 0) > 0) continue;
    if (nodes.length >= nodeBudget) {
      truncated = true;
      break;
    }
    nodes.push({
      id: sessionNodeId(s.id),
      type: 'session',
      label: sessionLabel(s),
      sizeDriver: 0,
      createdAt: s.createdAt,
    });
    includedSessionIds.add(s.id);
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
    // Echo the applied project filter (topN only) so the picker reflects selection.
    project: mode === 'topN' ? query.project : undefined,
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
      projects,
    },
  };
}

/**
 * A valid, empty GraphData payload — store is empty, the focus session is gone, or
 * a search matched nothing. `mode` is passed explicitly so a 0-hit search reports
 * `mode:'search'` (the client uses that to show "no results" instead of the
 * "memory is empty" state on a populated store; #35).
 */
function emptyGraph(
  mode: GraphScope['mode'],
  query: GraphQuery,
  totals: { totalSessions: number; totalObservations: number },
  similarity: boolean,
  nodeBudget: number,
  projects: string[],
): GraphData {
  return {
    version: GRAPH_CONTRACT_VERSION,
    scope: {
      mode,
      sessionId: query.session,
      limit: nodeBudget,
      nodeCap: NODE_CAP,
      edgeCap: EDGE_CAP,
      similarity,
      project: mode === 'topN' ? query.project : undefined,
    },
    nodes: [],
    edges: [],
    meta: {
      truncated: false,
      totalSessions: totals.totalSessions,
      totalObservations: totals.totalObservations,
      renderedNodes: 0,
      emptyStore: totals.totalSessions === 0 && totals.totalObservations === 0,
      projects,
    },
  };
}

/** The observations + their session hubs to render in `search` mode (#35). */
interface ResolvedSet {
  sessions: Session[];
  observations: Observation[];
  truncated: boolean;
}

/**
 * SEARCH mode (#35): resolve store-wide FTS matches into a renderable set. Keyword
 * index only (no embedder, no model load). The raw query is normalized through
 * `toFtsQuery` so punctuation/operators can't break the parser or inject FTS
 * syntax — a non-searchable query (empty / punctuation-only) yields no results
 * rather than an error. The `try/catch` is belt-and-suspenders: a malformed MATCH
 * must degrade to "no results", never a 500.
 */
function resolveSearch(store: MemoryStore, rawQuery: string): ResolvedSet {
  // Forgiving UI search: prefix matching (`migrat` → migration/migrations) plus
  // cross-language stemming (en default + pt/es) so a query reaches its whole word
  // family in the bilingual store. Opt-in here only; recall's per-prompt FTS leg
  // stays exact (#129).
  const expr = toFtsQuery(rawQuery, { prefix: true, stem: true });
  if (expr === null) return { sessions: [], observations: [], truncated: false };

  let hits: ReturnType<MemoryStore['searchFts']>;
  try {
    hits = store.searchFts(expr, SEARCH_CAP);
  } catch {
    return { sessions: [], observations: [], truncated: false };
  }

  const observations: Observation[] = [];
  for (const hit of hits) {
    const o = store.getObservation(hit.id);
    if (o) observations.push(o); // null-guard: index may drift ahead of rows
  }
  // More matches than the cap allowed → flag truncation (the node loop also flags
  // it if the rendered nodes hit NODE_CAP).
  let truncated = hits.length >= SEARCH_CAP;

  const sessions: Session[] = [];
  const seen = new Set<number>();
  for (const o of observations) {
    if (seen.has(o.sessionId)) continue;
    if (sessions.length >= SESSION_CAP) {
      truncated = true;
      break;
    }
    const s = store.getSession(o.sessionId);
    if (s) {
      sessions.push(s);
      seen.add(o.sessionId);
    }
  }
  return { sessions, observations, truncated };
}

/**
 * Prepend the newest consolidated observations (lesson/decision) and their session
 * hubs to the scope set (#35), deduped by id so a pin already in scope is not
 * counted twice. Pins go FIRST so the downstream node-budget guard drops the
 * lower-priority scope tail rather than the pins. A no-op when the store holds no
 * such observations — every pre-#35 caller path is unchanged.
 *
 * The pin footprint (pinned obs + the hubs they pull in) is bounded to at most HALF
 * the node budget. Node rendering emits all session hubs before any observation, so
 * an unbounded set of single-pin sessions could fill the budget with hubs and starve
 * the very pins it was meant to surface (#42 P2). By admitting pins one at a time and
 * charging each its hub cost, every pin we COMMIT to is guaranteed a render slot, and
 * at least half the budget stays free for the scope view.
 */
function mergePinnedConsolidated(
  store: MemoryStore,
  observations: Observation[],
  sessions: Session[],
  nodeBudget: number,
  project?: string,
): { observations: Observation[]; sessions: Session[] } {
  // `project` scopes the pins to the selected project's sessions (#129). Undefined
  // → store-wide pins (session scope's intentional cross-session surfacing, #35).
  const pinned = store.listObservations({
    kinds: PIN_KINDS,
    order: 'desc',
    limit: PIN_CAP,
    project,
  });
  if (pinned.length === 0) return { observations, sessions };

  const scopeIds = new Set(observations.map((o) => o.id));
  const candidates = pinned.filter((o) => !scopeIds.has(o.id));
  if (candidates.length === 0) return { observations, sessions };

  const pinBudget = Math.max(1, Math.floor(nodeBudget / 2));
  const haveSession = new Set(sessions.map((s) => s.id));
  const mergedSessions = [...sessions];
  const accepted: Observation[] = [];
  let spent = 0;
  for (const o of candidates) {
    const needsHub = !haveSession.has(o.sessionId);
    const cost = needsHub ? 2 : 1; // the pin itself, plus its hub when not yet present
    if (spent + cost > pinBudget) break;
    if (needsHub) {
      const s = store.getSession(o.sessionId);
      if (!s) continue; // session vanished — skip rather than orphan the pin
      mergedSessions.push(s);
      haveSession.add(o.sessionId);
    }
    accepted.push(o);
    spent += cost;
  }
  if (accepted.length === 0) return { observations, sessions };
  return { observations: [...accepted, ...observations], sessions: mergedSessions };
}
