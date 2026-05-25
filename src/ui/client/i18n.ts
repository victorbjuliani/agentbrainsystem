/**
 * Tiny, dependency-free i18n for the web client (international launch).
 *
 * EN is the source of truth and the DEFAULT: the UI renders English unless the
 * browser's locale is Portuguese. We fall back to `pt` only when `navigator`'s
 * primary language (or any entry in `navigator.languages`) starts with `pt`
 * (case-insensitive) — so a pt-BR/pt-PT user gets Portuguese, everyone else EN.
 *
 * The active language is resolved ONCE at module load into `lang`; the UI is built
 * fresh on every page load, so there is no in-session switch to honor.
 *
 * Dictionary shape: every key exists in BOTH maps (enforced by `Dict` being typed
 * off the `en` map's keys). A value is either a plain string or a function for the
 * count/plural-sensitive strings — `t(key, params)` interpolates `{n}` and lets the
 * function pick the right plural form. Technical tokens (node-type labels, code
 * identifiers like `abs ingest`) are intentionally NOT translated.
 */

/** Params passed to a plural-sensitive entry (`n` is the count; the rest are extra
 *  numeric slots the truncation banner needs). All optional except `n`. */
export interface TParams {
  n: number;
  rendered?: number;
  obs?: number;
  sessions?: number;
}

/** A dictionary entry: a constant string, or a function of the (count) params. */
type Entry = string | ((p: TParams) => string);

/** The EN map is the source of truth; the PT map must mirror its exact key set. */
const en = {
  // --- WebGL2 fallback (main.ts) -------------------------------------------
  webglUnsupported:
    'This visualization needs WebGL2. Update your browser or enable hardware acceleration to see the creature.',

  // --- Delete status / banners (main.ts) -----------------------------------
  nothingToDelete: 'nothing matched — nothing to delete',
  deletedN: ({ n }: TParams) => `deleted ${n} ${n === 1 ? 'memory' : 'memories'}`,
  alreadyGoneN: ({ n }: TParams) => `${n} ${n === 1 ? 'no longer existed' : 'no longer existed'}`,

  // --- Delete summaries (main.ts) ------------------------------------------
  deleteSessionSummary: 'Delete all observations from the session.',
  deleteObsSummary: 'Delete this observation.',
  deleteSearchSummary:
    'Delete exactly the previewed items matching the search (the set resolved by FTS, already capped — not an unbounded total).',

  // --- Scope chrome (overlays.ts) ------------------------------------------
  scopeProjectLabel: 'Scope: project to display',
  scopeSessionBtn: 'session',
  scopeSessionLabel: 'Scope: only the focused session',
  scopeAllBtn: 'all',
  scopeAllLabel: 'Scope: all memory (constellation)',
  scopeGroupLabel: 'Graph scope',
  similarityBtn: 'similarity',
  similarityLabel: 'Toggle similarity edges',
  brandSub: 'memory graph',
  allProjects: 'all projects',

  // --- Search + theme chrome (overlays.ts) ---------------------------------
  searchPlaceholder: 'search memory…',
  searchLabel: 'Search nodes by content or id',
  searchDeleteBtn: 'delete search',
  searchDeleteLabel:
    'Delete the memories matched by the search (a capped set, not everything that matches)',
  themeLabel: 'Toggle light/dark theme',
  topRightLabel: 'Search and theme',

  // --- Type-filter pills (overlays.ts) -------------------------------------
  // {type} is a technical node-type token (session/user/…) — interpolated raw.
  pillFilterLabel: 'Filter nodes of type',
  legendLabel: 'Filter by node type',

  // --- Inspector (overlays.ts) ---------------------------------------------
  inspectorLabel: 'Selected node inspector',
  inspectorClose: 'Close inspector',
  deleteSessionLabel: 'Delete the whole session',
  deleteObsLabel: 'Delete this observation',
  deleteSessionTitle: 'delete session',
  deleteObsTitle: 'delete observation',

  // --- Empty / zero states (overlays.ts) -----------------------------------
  emptyTitle: 'memory is empty',
  emptyRunPrefix: 'run ',
  emptyRunSuffix: ' to populate the graph',
  noResultsTitle: 'no results',
  noResultsSub: 'no memory matches the search',
  emptyScopeTitle: 'empty scope',
  emptyScopeSub: 'no nodes in this scope — try another project or top 200',

  // --- Truncation banner (overlays.ts) -------------------------------------
  truncBanner: (p: TParams) =>
    `showing ${p.rendered} nodes · store has ${p.obs} obs / ${p.sessions} sessions`,

  // --- Delete dialog (delete-client.ts) ------------------------------------
  deleteMoreN: ({ n }: TParams) => `…and ${n} more`,
  deleteNotFoundN: ({ n }: TParams) =>
    `${n} ${n === 1 ? 'id no longer exists' : 'ids no longer exist'} (ignored)`,
  deleteCancel: 'cancel',
  deleteConfirmN: ({ n }: TParams) => `delete ${n}`,
  deleteDialogTitle: 'delete memory',
  deleteCountN: ({ n }: TParams) => `${n} ${n === 1 ? 'item' : 'items'}`,
  deleteWarn: 'Permanent and irreversible deletion.',

  // --- index.html static copy (rendered title) -----------------------------
  graphAriaLabel: 'Interactive graph of the agent memory',
} as const;

/** Keys must mirror `en` exactly; values may be strings or count functions. */
type Dict = Record<keyof typeof en, Entry>;

/** Faithful pt-BR translations (the prior in-tree PT strings, reused verbatim). */
const pt: Dict = {
  webglUnsupported:
    'Esta visualização precisa de WebGL2. Atualize o navegador ou habilite a aceleração de hardware para ver a criatura.',

  nothingToDelete: 'nada correspondeu — nada a excluir',
  deletedN: ({ n }: TParams) => `excluídas ${n} ${n === 1 ? 'memória' : 'memórias'}`,
  alreadyGoneN: ({ n }: TParams) => `${n} já não ${n === 1 ? 'existia' : 'existiam'}`,

  deleteSessionSummary: 'Excluir todas as observações da sessão.',
  deleteObsSummary: 'Excluir esta observação.',
  deleteSearchSummary:
    'Excluir exatamente os itens previstos que correspondem à busca (conjunto resolvido pela busca FTS, já limitado — não um total irrestrito).',

  scopeProjectLabel: 'Escopo: projeto a exibir',
  scopeSessionBtn: 'sessão',
  scopeSessionLabel: 'Escopo: só a sessão em foco',
  scopeAllBtn: 'tudo',
  scopeAllLabel: 'Escopo: toda a memória (constelação)',
  scopeGroupLabel: 'Escopo do grafo',
  similarityBtn: 'similaridade',
  similarityLabel: 'Alternar arestas de similaridade',
  brandSub: 'memory graph',
  allProjects: 'todos os projetos',

  searchPlaceholder: 'buscar memória…',
  searchLabel: 'Buscar nós por conteúdo ou id',
  searchDeleteBtn: 'excluir busca',
  searchDeleteLabel:
    'Excluir as memórias previstas pela busca (conjunto limitado, não tudo que corresponde)',
  themeLabel: 'Alternar tema claro/escuro',
  topRightLabel: 'Busca e tema',

  pillFilterLabel: 'Filtrar nós do tipo',
  legendLabel: 'Filtro por tipo de nó',

  inspectorLabel: 'Inspetor do nó selecionado',
  inspectorClose: 'Fechar inspetor',
  deleteSessionLabel: 'Excluir toda a sessão',
  deleteObsLabel: 'Excluir esta observação',
  deleteSessionTitle: 'excluir sessão',
  deleteObsTitle: 'excluir observação',

  emptyTitle: 'memória vazia',
  emptyRunPrefix: 'rode ',
  emptyRunSuffix: ' para popular o grafo',
  noResultsTitle: 'nenhum resultado',
  noResultsSub: 'nenhuma memória corresponde à busca',
  emptyScopeTitle: 'escopo vazio',
  emptyScopeSub: 'nenhum nó neste escopo — tente outro projeto ou top 200',

  truncBanner: (p: TParams) =>
    `mostrando ${p.rendered} nós · store tem ${p.obs} obs / ${p.sessions} sessões`,

  deleteMoreN: ({ n }: TParams) => `…e mais ${n}`,
  deleteNotFoundN: ({ n }: TParams) =>
    `${n} ${n === 1 ? 'id já não existe' : 'ids já não existem'} (ignorado${n === 1 ? '' : 's'})`,
  deleteCancel: 'cancelar',
  deleteConfirmN: ({ n }: TParams) => `excluir ${n}`,
  deleteDialogTitle: 'excluir memória',
  deleteCountN: ({ n }: TParams) => `${n} ${n === 1 ? 'item' : 'itens'}`,
  deleteWarn: 'Exclusão permanente e irreversível.',

  graphAriaLabel: 'Grafo interativo da memória do agente',
};

/** True when a BCP-47 tag (or undefined) denotes Portuguese. */
function isPortuguese(tag: string | undefined): boolean {
  return typeof tag === 'string' && tag.toLowerCase().startsWith('pt');
}

/** Resolve the active language ONCE: `pt` only for a Portuguese locale, else `en`. */
function resolveLang(): 'en' | 'pt' {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (!nav) return 'en';
  if (isPortuguese(nav.language)) return 'pt';
  const langs = nav.languages;
  if (Array.isArray(langs) && langs.some(isPortuguese)) return 'pt';
  return 'en';
}

/** The active UI language, fixed for the lifetime of the page. */
const lang: 'en' | 'pt' = resolveLang();

/** The active dictionary (EN by default, PT only for a Portuguese locale). */
const dict: Dict = lang === 'pt' ? pt : en;

/**
 * Translate `key` in the active language. Plural/count-sensitive entries are
 * functions and require their params (`{ n }`, plus `rendered/obs/sessions` for the
 * truncation banner); plain string entries ignore any params passed.
 */
export function t(key: keyof typeof en, params?: TParams): string {
  const entry = dict[key];
  if (typeof entry === 'function') return entry(params ?? { n: 0 });
  return entry;
}
