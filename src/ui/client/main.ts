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
import {
  type ClientSelector,
  confirmDelete,
  executeDelete,
  previewDelete,
  StaleTokenError,
} from './delete-client.js';
import { mountOverlays, type SessionOption } from './overlays.js';
import { createRenderer, radiusFor } from './render.js';
import type { ScopeMode, Theme, ViewEdge, ViewGraph, ViewNode } from './types.js';
import './app.css';

const THEME_KEY = 'abs.theme';

interface ScopeState {
  mode: ScopeMode;
  sessionId?: number;
  similarity: boolean;
  /**
   * Active store-wide search (#35). When set, it drives an authoritative server
   * fetch (FTS) that reaches obs OUTSIDE the topN/session window, so it takes
   * precedence over `mode`/`sessionId` in the query string.
   */
  search?: string;
}

/** Build the `/api/graph` query string from the current scope. */
function scopeToQuery(scope: ScopeState): string {
  const p = new URLSearchParams();
  if (scope.search) {
    // Search is store-wide and authoritative — it supersedes the topN/session
    // scope server-side, so we send only it (plus the similarity toggle).
    p.set('search', scope.search);
  } else if (scope.mode === 'topN') {
    p.set('topN', '200');
  } else if (scope.sessionId !== undefined) {
    p.set('session', String(scope.sessionId));
  }
  if (scope.similarity) p.set('similarity', '1');
  const qs = p.toString();
  return qs ? `/api/graph?${qs}` : '/api/graph';
}

/** Project the frozen wire payload into the renderer's view model. */
function toViewGraph(data: GraphData): ViewGraph {
  const nodes: ViewNode[] = data.nodes.map((n) => ({
    ...n,
    radius: radiusFor(n.type, n.sizeDriver),
    phase: Math.random() * Math.PI * 2,
    breathRate: 1.4 + Math.random() * 1.2, // ~0.22–0.41 Hz, desynchronized
  }));
  const links: ViewEdge[] = data.edges.map((e) => ({ ...e }));
  return { nodes, links };
}

/** Derive the session dropdown options from the rendered session hubs. */
function sessionOptions(data: GraphData): SessionOption[] {
  return data.nodes
    .filter((n) => n.type === 'session')
    .map((n) => ({ id: Number(n.id.slice(2)), label: n.label }));
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

  applyTheme(loadTheme());

  const scope: ScopeState = { mode: 'session', similarity: false };
  // Visible types: start with everything; pills toggle entries off.
  const visibleTypes = new Set<NodeType>([
    'session',
    'user',
    'assistant',
    'tool',
    'lesson',
    'decision',
  ]);

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
        showError('nothing matched — nothing to delete');
        return;
      }
      const ok = await confirmDelete(previewResult, summary);
      if (!ok) return;
      const result = await executeDelete(previewResult.handle);
      renderer.select(null);
      overlays.showInspector(null);
      await load(); // refresh the graph so the deleted nodes disappear
      // H1: confirm the positive outcome (don't drop notFound). Announced politely.
      const n = result.deleted.length;
      let msg = `excluídas ${n} ${n === 1 ? 'memória' : 'memórias'}`;
      if (result.notFound.length > 0) {
        const m = result.notFound.length;
        msg += ` · ${m} já não ${m === 1 ? 'existia' : 'existiam'}`;
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
        summary: `Excluir todas as observações da sessão "${node.label}".`,
      };
    }
    const id = Number(node.id.slice(2));
    return {
      selector: { sel: 'ids', ids: [id] },
      summary: `Excluir esta observação (#${id}).`,
    };
  }

  const renderer = createRenderer(mount, {
    onSelect: (node) => overlays.showInspector(node),
  });

  const overlays = mountOverlays(overlayRoot, {
    onToggleType: (type, enabled) => {
      if (enabled) visibleTypes.add(type);
      else visibleTypes.delete(type);
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
      void runDelete(
        { sel: 'search', q: lastSearch, limit: 50 },
        `Excluir exatamente os itens previstos que correspondem a "${lastSearch}" (conjunto resolvido pela busca FTS, já limitado — não um total irrestrito).`,
      );
    },
    onScopeChange: (next) => {
      // Changing scope (session/topN/similarity) exits search: clear the active
      // query so the chosen scope is what loads (the input is cleared in overlays).
      scope.mode = next.mode;
      scope.sessionId = next.sessionId;
      scope.similarity = next.similarity;
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
      overlays.syncFromData(data, sessionOptions(data));
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
