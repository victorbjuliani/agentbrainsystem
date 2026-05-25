/**
 * Client entrypoint (issue #11) — the container that wires data → renderer →
 * overlays. Read-only: it only ever GETs `/api/graph`. No write path exists.
 *
 * Flow: fetch the graph for the current scope, assert the contract version,
 * project the wire payload into the renderer's view model (radius + breathing
 * phase), and hand the chrome (overlays.ts) the metadata it needs. Scope changes,
 * filters, search, selection, and theme all flow back through here.
 *
 * Shares the wire contract with the backend via `../graph-types.js`.
 */
import { GRAPH_CONTRACT_VERSION, type GraphData, type NodeType } from '../graph-types.js';
import { CreatureUnsupportedError, createRenderer } from './creature.js';
import {
  type ClientSelector,
  confirmDelete,
  executeDelete,
  previewDelete,
  StaleTokenError,
} from './delete-client.js';
import { t } from './i18n.js';
import { mountOverlays } from './overlays.js';
import { scopeToQuery } from './scope.js';
import type { ScopeState, Theme, ViewEdge, ViewGraph, ViewNode } from './types.js';
import { presentTypes } from './visible-types.js';
import './app.css';

const THEME_KEY = 'abs.theme';

/** Every node type — the default lens (all visible) until a pill isolates one. */
const ALL_TYPES: readonly NodeType[] = [
  'session',
  'user',
  'assistant',
  'tool',
  'lesson',
  'decision',
];

/** Project the frozen wire payload into the renderer's view model. The creature
 *  renderer derives all geometry from the wire fields, so this is a thin copy. */
function toViewGraph(data: GraphData): ViewGraph {
  const nodes: ViewNode[] = data.nodes.map((n) => ({ ...n }));
  const links: ViewEdge[] = data.edges.map((e) => ({ ...e }));
  return { nodes, links };
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // Keep the native UA chrome (scrollbars/inputs) in step with the palette.
  document.documentElement.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0a0810' : '#fafaf9');
}

function loadTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'dark';
}

async function fetchGraph(scope: ScopeState): Promise<GraphData> {
  const res = await fetch(scopeToQuery(scope));
  if (!res.ok) throw new Error(`graph request failed: ${res.status}`);
  const data = (await res.json()) as GraphData;
  if (data.version !== GRAPH_CONTRACT_VERSION) {
    throw new Error(
      `graph contract mismatch: server v${data.version}, client v${GRAPH_CONTRACT_VERSION}`,
    );
  }
  return data;
}

async function main(): Promise<void> {
  const mount = document.getElementById('graph');
  const overlayRoot = document.getElementById('overlays');
  if (!mount || !overlayRoot) throw new Error('missing #graph / #overlays mount');

  // The graph aria-label is EN-default in index.html (static copy a no-JS read gets);
  // localize it for a Portuguese locale so AT users hear the right language.
  mount.setAttribute('aria-label', t('graphAriaLabel'));

  applyTheme(loadTheme());

  // Open on the store-wide constellation with similarity edges (the "living brain"
  // hero, DESIGN §0) — not a single recent session, which can render near-empty.
  // Clicking a session hub still drills into `session` mode (see onSelect below).
  const scope: ScopeState = { mode: 'topN', similarity: true };
  // Visible types: a lens over the current payload. Reset to the payload's present
  // types on every load (see load()); pills isolate/restore/toggle within that.
  let visibleTypes = new Set<NodeType>(ALL_TYPES);

  let lastSearch = '';

  /**
   * The single write-path orchestrator (ADR-0007): preview → confirm dialog →
   * execute → re-fetch the graph. `summary` makes the scope explicit so a capped
   * search delete never reads as an uncapped total. A stale CSRF token reloads `/`.
   */
  async function runDelete(selector: ClientSelector, summary: string): Promise<void> {
    try {
      const previewResult = await previewDelete(selector);
      if (previewResult.count === 0) {
        showError(t('nothingToDelete'));
        return;
      }
      const ok = await confirmDelete(previewResult, summary);
      if (!ok) return;
      const result = await executeDelete(previewResult.handle);
      renderer.select(null);
      overlays.showInspector(null);
      await load(); // refresh the graph so the deleted nodes disappear
      // H1: confirm the positive outcome (don't drop notFound). Announced politely.
      let msg = t('deletedN', { n: result.deleted.length });
      if (result.notFound.length > 0) {
        msg += ` · ${t('alreadyGoneN', { n: result.notFound.length })}`;
      }
      showStatus(msg);
    } catch (err) {
      if (err instanceof StaleTokenError) return; // page is reloading for a fresh token
      showError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Map a clicked node id (`o:<id>` | `s:<id>`) to its delete selector + summary. */
  function deleteForNode(node: ViewNode): { selector: ClientSelector; summary: string } | null {
    if (node.type === 'session') {
      const id = Number(node.id.slice(2));
      return {
        selector: { sel: 'session', id },
        summary: t('deleteSessionSummary'),
      };
    }
    const id = Number(node.id.slice(2));
    return {
      selector: { sel: 'ids', ids: [id] },
      summary: t('deleteObsSummary'),
    };
  }

  // WebGL2 is required for the creature (ADR-0015). On a context-less browser we
  // surface an on-brand message instead of a black canvas, and stop wiring the rest.
  let renderer: ReturnType<typeof createRenderer>;
  try {
    renderer = createRenderer(mount, {
      onSelect: (node) => onSelectNode(node),
    });
  } catch (err) {
    if (err instanceof CreatureUnsupportedError) {
      showError(t('webglUnsupported'));
      return;
    }
    throw err;
  }

  function onSelectNode(node: ViewNode | null): void {
    overlays.showInspector(node);
    // Clicking a session hub focuses that session (session mode) — this replaces
    // the old session dropdown. Observation clicks only inspect, never re-scope.
    if (node?.type === 'session') {
      const id = Number(node.id.slice(2));
      if (scope.mode === 'session' && scope.sessionId === id) return; // already focused
      scope.mode = 'session';
      scope.sessionId = id;
      scope.project = undefined;
      scope.search = undefined;
      lastSearch = '';
      void load();
    }
  }

  const overlays = mountOverlays(overlayRoot, {
    onSetVisibleTypes: (types) => {
      // The pill chrome computes the whole target set (isolate / restore / additive)
      // via the pure visible-types module, so the container just applies it.
      visibleTypes = new Set(types);
      renderer.setVisibleTypes(new Set(visibleTypes));
    },
    onSearch: (query) => {
      // Server-side search (#35): the query drives an authoritative store-wide FTS
      // fetch (reaches obs outside the recency/scope window). Clearing it reverts to
      // the preserved scope. No client-side highlight: the payload is already the
      // match set, so dimming non-matches would be a no-op.
      lastSearch = query.trim();
      scope.search = lastSearch || undefined;
      void load();
    },
    onSearchDelete: () => {
      if (!lastSearch) return;
      void runDelete({ sel: 'search', q: lastSearch, limit: 50 }, t('deleteSearchSummary'));
    },
    onScopeChange: (next) => {
      // Changing scope (session/topN/similarity) exits search: clear the active
      // query so the chosen scope is what loads (the input is cleared in overlays).
      scope.mode = next.mode;
      scope.sessionId = next.sessionId;
      scope.similarity = next.similarity;
      scope.project = next.project;
      scope.search = undefined;
      lastSearch = '';
      void load();
    },
    onThemeChange: (theme) => {
      applyTheme(theme);
      localStorage.setItem(THEME_KEY, theme);
      overlays.setTheme(theme);
      renderer.refreshTheme();
    },
    onInspectorClose: () => {
      renderer.select(null);
      overlays.showInspector(null);
    },
    onInspectorDelete: (node) => {
      const plan = deleteForNode(node);
      if (plan) void runDelete(plan.selector, plan.summary);
    },
  });

  function sizeCanvas(): void {
    renderer.resize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', sizeCanvas);
  sizeCanvas();

  /** Surface a failure on-brand in the error banner rather than a blank canvas. */
  function showError(message: string): void {
    const banner = document.getElementById('error-banner');
    if (banner) {
      banner.textContent = message;
      banner.hidden = false;
    }
  }

  /**
   * Announce a positive outcome (a successful delete) via the polite aria-live
   * region, and auto-dismiss it after a few seconds. Clears any prior error banner
   * so a success doesn't sit beside a stale failure.
   */
  let statusTimer = 0;
  function showStatus(message: string): void {
    const errBanner = document.getElementById('error-banner');
    if (errBanner) errBanner.hidden = true;
    const banner = document.getElementById('status-banner');
    if (!banner) return;
    banner.textContent = message;
    banner.hidden = false;
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      banner.hidden = true;
    }, 6000);
  }

  // Monotonic request token: search fires load() per debounced keystroke, so
  // multiple fetches can be in flight. Only the LATEST may apply its payload —
  // a slower earlier response must not overwrite newer results (#42 P2).
  let loadSeq = 0;
  async function load(): Promise<void> {
    const seq = ++loadSeq;
    document.body.setAttribute('aria-busy', 'true');
    try {
      const data = await fetchGraph(scope);
      if (seq !== loadSeq) return; // superseded by a newer load — drop stale payload
      overlays.syncFromData(data);
      // Reset the type lens to whatever this payload actually contains: a fresh
      // scope (or search) shows everything present, and any prior pill isolation is
      // dropped rather than silently hiding a type the new scope still has (#35/#43).
      const present = presentTypes(data.nodes);
      visibleTypes = present.size > 0 ? present : new Set(ALL_TYPES);
      renderer.setData(toViewGraph(data));
      renderer.setVisibleTypes(new Set(visibleTypes));
    } catch (err) {
      if (seq !== loadSeq) return; // stale failure from a superseded request
      showError(err instanceof Error ? err.message : String(err));
      // eslint-disable-next-line no-console
      console.error('failed to load graph', err);
    } finally {
      if (seq === loadSeq) document.body.removeAttribute('aria-busy');
    }
  }

  await load();
}

void main();
