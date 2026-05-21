/**
 * Floating overlay chrome (issue #11, DESIGN §11). These never form an opaque
 * top-bar that eats the canvas — they float with backdrop-blur over the graph.
 *
 * Pieces:
 *   - Type-filter pills (colored by taxonomy; dimmed when absent from the payload).
 *   - Search input (mono) driving a store-wide server search (#35).
 *   - Scope controls: session dropdown / topN toggle + similarity-edges toggle.
 *   - Inspector (on select): compact mono metadata panel, glow-md surface.
 *   - Theme toggle (dark/light).
 *   - Truncation banner ("showing N of M") when a cap clipped the graph.
 *
 * All DOM is built with semantic elements + aria; interactive controls inherit the
 * visible focus ring from app.css. No business logic lives here — callbacks bubble
 * intent up to main.ts (the container).
 */
import type { GraphData, GraphMeta, GraphNode, NodeType } from '../graph-types.js';
import { TAXONOMY } from './palette.js';
import type { ScopeMode, Theme, ViewNode } from './types.js';

export interface OverlayCallbacks {
  onToggleType(type: NodeType, enabled: boolean): void;
  onSearch(query: string): void;
  /** "Delete the N matching" affordance on the search box (ADR-0007 write path). */
  onSearchDelete(): void;
  onScopeChange(scope: { mode: ScopeMode; sessionId?: number; similarity: boolean }): void;
  onThemeChange(theme: Theme): void;
  onInspectorClose(): void;
  /** Delete the inspected node (an observation, or a whole session hub). */
  onInspectorDelete(node: ViewNode): void;
}

export interface SessionOption {
  id: number;
  label: string;
}

export interface Overlays {
  /** Reflect a freshly-loaded payload (pill availability, truncation banner). */
  syncFromData(data: GraphData, sessions: SessionOption[]): void;
  /** Render the inspector for the selected node (or hide it on null). */
  showInspector(node: ViewNode | null): void;
  setTheme(theme: Theme): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

export function mountOverlays(root: HTMLElement, cb: OverlayCallbacks): Overlays {
  // --- Top-left: brand + scope ---------------------------------------------
  const sessionSelect = el('select', {
    id: 'scope-session',
    class: 'control select',
    'aria-label': 'Escopo: sessão a exibir',
  });
  const topNBtn = el(
    'button',
    { type: 'button', class: 'control toggle', 'aria-pressed': 'false' },
    ['top 200'],
  );
  const simBtn = el(
    'button',
    {
      type: 'button',
      class: 'control toggle',
      'aria-pressed': 'false',
      'aria-label': 'Alternar arestas de similaridade',
    },
    ['similaridade'],
  );

  let mode: ScopeMode = 'session';
  let similarity = false;

  function emitScope(): void {
    // A scope change exits search (#35): clear the box so it never shows a stale
    // query against a non-search payload, and hide its delete affordance. Cancel
    // any pending search debounce so a timer mid-flight can't fire a redundant
    // onSearch('') after we've already blanked the input.
    window.clearTimeout(searchDebounce);
    if (searchInput.value !== '') {
      searchInput.value = '';
      searchDeleteBtn.hidden = true;
    }
    const sel = sessionSelect.value;
    cb.onScopeChange({
      mode,
      sessionId: mode === 'session' && sel ? Number(sel) : undefined,
      similarity,
    });
  }

  sessionSelect.addEventListener('change', () => {
    mode = 'session';
    topNBtn.setAttribute('aria-pressed', 'false');
    emitScope();
  });
  topNBtn.addEventListener('click', () => {
    mode = mode === 'topN' ? 'session' : 'topN';
    topNBtn.setAttribute('aria-pressed', String(mode === 'topN'));
    emitScope();
  });
  simBtn.addEventListener('click', () => {
    similarity = !similarity;
    simBtn.setAttribute('aria-pressed', String(similarity));
    emitScope();
  });

  const truncBanner = el('p', { id: 'trunc-banner', class: 'trunc', hidden: '' });

  const topLeft = el('section', { class: 'overlay overlay-tl', 'aria-label': 'Escopo do grafo' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'brand-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'brand-name' }, ['agentbrainsystem']),
      el('span', { class: 'brand-sub' }, ['memory graph']),
    ]),
    el('div', { class: 'scope-row' }, [sessionSelect, topNBtn, simBtn]),
    truncBanner,
  ]);

  // --- Top-right: search + theme -------------------------------------------
  const searchInput = el('input', {
    type: 'search',
    id: 'search',
    class: 'control search',
    placeholder: 'buscar memória…',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Buscar nós por conteúdo ou id',
  });
  let searchDebounce = 0;
  // "Delete the N matching" — hidden until the search box has a query (ADR-0007).
  const searchDeleteBtn = el(
    'button',
    {
      type: 'button',
      class: 'control toggle search-delete',
      'aria-label':
        'Excluir as memórias previstas pela busca (conjunto limitado, não tudo que corresponde)',
      hidden: '',
    },
    ['excluir busca'],
  );
  searchDeleteBtn.addEventListener('click', () => cb.onSearchDelete());
  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchDebounce);
    searchDeleteBtn.hidden = searchInput.value.trim() === '';
    searchDebounce = window.setTimeout(() => cb.onSearch(searchInput.value), 250);
  });

  const themeBtn = el(
    'button',
    {
      type: 'button',
      id: 'theme-toggle',
      class: 'control icon-btn',
      'aria-label': 'Alternar tema claro/escuro',
    },
    ['◐'],
  );
  let theme: Theme = (document.documentElement.dataset.theme as Theme) ?? 'dark';
  themeBtn.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    cb.onThemeChange(theme);
  });

  const topRight = el('section', { class: 'overlay overlay-tr', 'aria-label': 'Busca e tema' }, [
    searchInput,
    searchDeleteBtn,
    themeBtn,
  ]);

  // --- Bottom-left: type-filter pills / legend -----------------------------
  const pillMap = new Map<NodeType, HTMLButtonElement>();
  const pills = TAXONOMY.map((meta) => {
    const swatch = el('span', { class: 'pill-dot', 'aria-hidden': 'true' });
    swatch.style.setProperty('--pill-color', `var(${meta.cssVar})`);
    const pill = el(
      'button',
      {
        type: 'button',
        class: 'pill',
        'data-type': meta.type,
        'aria-pressed': 'true',
        'aria-label': `Filtrar nós do tipo ${meta.label}`,
      },
      [swatch, el('span', { class: 'pill-label' }, [meta.label])],
    );
    pill.addEventListener('click', () => {
      const next = pill.getAttribute('aria-pressed') !== 'true';
      pill.setAttribute('aria-pressed', String(next));
      cb.onToggleType(meta.type, next);
    });
    pillMap.set(meta.type, pill as HTMLButtonElement);
    return pill;
  });
  const legend = el(
    'section',
    { class: 'overlay overlay-bl', 'aria-label': 'Filtro por tipo de nó' },
    pills,
  );

  // --- Inspector (right drawer, hidden until select) -----------------------
  const inspector = el('aside', {
    id: 'inspector',
    class: 'overlay inspector',
    role: 'complementary',
    'aria-label': 'Inspetor do nó selecionado',
    hidden: '',
  });
  function renderInspector(node: ViewNode): void {
    inspector.replaceChildren();
    const closeBtn = el(
      'button',
      { type: 'button', class: 'icon-btn inspect-close', 'aria-label': 'Fechar inspetor' },
      ['×'],
    );
    closeBtn.addEventListener('click', () => cb.onInspectorClose());

    // Delete affordance (ADR-0007): for a session hub it removes the whole session;
    // for an observation it removes just that one. The full preview/confirm flow runs
    // upstream — this only signals intent.
    const deleteBtn = el(
      'button',
      {
        type: 'button',
        class: 'icon-btn inspect-delete',
        'aria-label': node.type === 'session' ? 'Excluir toda a sessão' : 'Excluir esta observação',
        title: node.type === 'session' ? 'excluir sessão' : 'excluir observação',
      },
      ['🗑'],
    );
    deleteBtn.addEventListener('click', () => cb.onInspectorDelete(node));

    const head = el('header', { class: 'inspect-head' }, [
      el('span', { class: 'inspect-type', 'data-type': node.type }, [node.type]),
      el('div', { class: 'inspect-head-actions' }, [deleteBtn, closeBtn]),
    ]);

    const rows: (Node | string)[] = [];
    const addRow = (k: string, v: string): void => {
      rows.push(
        el('div', { class: 'meta-row' }, [
          el('span', { class: 'meta-key' }, [k]),
          el('span', { class: 'meta-val' }, [v]),
        ]),
      );
    };
    addRow('id', node.id);
    addRow('type', node.type);
    addRow('createdAt', fmtTimestamp(node.createdAt));
    if (node.sessionId) addRow('session', node.sessionId);
    addRow('degree', String(node.sizeDriver));

    const body = el('div', { class: 'inspect-body' }, [
      el('div', { class: 'meta-grid' }, rows),
      el('div', { class: 'inspect-content-wrap' }, [
        el('span', { class: 'meta-key' }, ['content']),
        el('pre', { class: 'inspect-content' }, [node.label]),
      ]),
    ]);
    inspector.append(head, body);
  }

  // --- Empty state (centered, on-brand) ------------------------------------
  const emptyState = el('div', { id: 'empty-state', class: 'empty', hidden: '' }, [
    el('div', { class: 'empty-glyph', 'aria-hidden': 'true' }, ['◌']),
    el('h1', { class: 'empty-title' }, ['memory is empty']),
    el('p', { class: 'empty-sub' }, [
      'run ',
      el('code', { class: 'empty-code', translate: 'no' }, ['abs ingest']),
      ' to populate the graph',
    ]),
  ]);

  // --- Zero-node state (#35/#43) — distinct from "memory is empty" ----------
  // A populated store that resolves to zero nodes must NOT read as "empty store".
  // Two flavours: a 0-hit search, or a non-search scope that resolves nothing
  // (e.g. a deleted/missing session id) — both get guidance, never a blank canvas.
  const noResultsTitle = el('h1', { class: 'empty-title' }, ['nenhum resultado']);
  const noResultsSub = el('p', { class: 'empty-sub' }, ['nenhuma memória corresponde à busca']);
  const noResults = el('div', { id: 'no-results', class: 'empty', hidden: '' }, [
    el('div', { class: 'empty-glyph', 'aria-hidden': 'true' }, ['⌕']),
    noResultsTitle,
    noResultsSub,
  ]);

  root.append(topLeft, topRight, legend, inspector, emptyState, noResults);

  return {
    syncFromData(data: GraphData, sessions: SessionOption[]): void {
      // Session dropdown.
      sessionSelect.replaceChildren();
      for (const s of sessions) {
        const opt = el('option', { value: String(s.id) }, [s.label]);
        if (data.scope.sessionId === s.id) opt.selected = true;
        sessionSelect.append(opt);
      }
      // Reflect resolved scope onto the toggles.
      topNBtn.setAttribute('aria-pressed', String(data.scope.mode === 'topN'));
      simBtn.setAttribute('aria-pressed', String(data.scope.similarity));

      // Pills: enable only types present in this payload (DESIGN §4 — tool is conditional).
      const present = new Set<NodeType>(data.nodes.map((n: GraphNode) => n.type));
      for (const [type, pill] of pillMap) {
        const has = present.has(type);
        pill.classList.toggle('pill-absent', !has);
        if (!has) pill.title = 'nenhum nó deste tipo no escopo atual';
        else pill.removeAttribute('title');
      }

      // Truncation banner.
      const meta: GraphMeta = data.meta;
      if (meta.truncated) {
        truncBanner.hidden = false;
        // renderedNodes is scope-local; the store totals are store-wide — keep
        // the wording explicit so it never reads as "12 of 9000" in one scope.
        truncBanner.textContent = `mostrando ${meta.renderedNodes} nós · store tem ${meta.totalObservations} obs / ${meta.totalSessions} sessões`;
      } else {
        truncBanner.hidden = true;
      }

      // Empty state: ONLY when the store itself is empty. A populated store that
      // resolves to zero nodes gets the distinct zero-node state instead — for a
      // 0-hit search OR a non-search scope that resolves nothing (e.g. a missing
      // session id), so the user never faces a silent blank canvas (#35/#43).
      const zeroOnPopulated = data.nodes.length === 0 && !meta.emptyStore;
      emptyState.hidden = !meta.emptyStore;
      noResults.hidden = !zeroOnPopulated;
      if (zeroOnPopulated) {
        const searching = data.scope.mode === 'search';
        noResultsTitle.textContent = searching ? 'nenhum resultado' : 'escopo vazio';
        noResultsSub.textContent = searching
          ? 'nenhuma memória corresponde à busca'
          : 'nenhum nó neste escopo — tente outra sessão ou top 200';
      }
    },
    showInspector(node: ViewNode | null): void {
      if (!node) {
        inspector.hidden = true;
        inspector.classList.remove('open');
        return;
      }
      renderInspector(node);
      inspector.hidden = false;
      // Force reflow so the open transition runs from the hidden state.
      void inspector.offsetWidth;
      inspector.classList.add('open');
    },
    setTheme(next: Theme): void {
      theme = next;
    },
  };
}
