/**
 * The UI write path for selective hard-delete (Phase B2 / ADR-0007).
 *
 * This is the ONLY place in the client that talks to the delete routes. The flow
 * mirrors the server's two-phase contract: `previewDelete(selector)` resolves a
 * selector to a pinned id set (returns a `handle` + the items it would delete), the
 * caller shows a confirmation dialog, and only on confirm does `executeDelete(handle)`
 * actually delete that exact set.
 *
 * Security wiring (ADR-0007):
 *   - The per-process CSRF token is read at RUNTIME from `<meta name="abs-csrf">`
 *     (templated into `/` by the server), never a build-time constant — so a server
 *     restart that mints a fresh token is picked up by reloading `/`.
 *   - On a 403 (the token went stale after a process restart), we reload `/` to fetch
 *     a fresh token rather than leaving the user stuck.
 *   - The selector travels in the query string (no request body) to match the server.
 */

/** A delete selector, mirrored from the core `DeleteSelector` (query-string shape). */
export type ClientSelector =
  | { sel: 'ids'; ids: number[] }
  | { sel: 'session'; id: number }
  | { sel: 'project'; project: string }
  | { sel: 'null-project' }
  | { sel: 'search'; q: string; limit?: number };

/** One previewed observation (subset of the server preview item). */
export interface PreviewItem {
  id: number;
  kind: string;
  snippet: string;
  sessionId: number;
  createdAt: string;
}

/** The server's `POST /api/delete/preview` payload. */
export interface PreviewResult {
  handle: string;
  count: number;
  items: PreviewItem[];
  notFound: number[];
}

/** The server's `DELETE /api/delete` payload. */
export interface ExecuteResult {
  deleted: number[];
  notFound: number[];
}

/** Thrown on a 403 so callers can recover by reloading `/` for a fresh CSRF token. */
export class StaleTokenError extends Error {
  constructor() {
    super('csrf token stale — reload required');
    this.name = 'StaleTokenError';
  }
}

/** Read the per-process CSRF token the server templated into the page. */
function csrfToken(): string {
  const meta = document.querySelector('meta[name="abs-csrf"]');
  return meta?.getAttribute('content') ?? '';
}

/** Build the `/api/delete*` query string from a selector. */
function selectorQuery(selector: ClientSelector): string {
  const p = new URLSearchParams();
  p.set('sel', selector.sel);
  switch (selector.sel) {
    case 'ids':
      p.set('ids', selector.ids.join(','));
      break;
    case 'session':
      p.set('id', String(selector.id));
      break;
    case 'project':
      p.set('project', selector.project);
      break;
    case 'search':
      p.set('q', selector.q);
      if (selector.limit !== undefined) p.set('limit', String(selector.limit));
      break;
    case 'null-project':
      break;
  }
  return p.toString();
}

/**
 * If the response is a 403, the per-process CSRF token went stale (server restart).
 * Reload `/` to pull a fresh token; the user can retry after the page reloads.
 */
function recoverIfStale(status: number): void {
  if (status === 403) {
    window.location.reload();
    throw new StaleTokenError();
  }
}

/** Resolve a selector to a pinned id set (read-only on the server). */
export async function previewDelete(selector: ClientSelector): Promise<PreviewResult> {
  const res = await fetch(`/api/delete/preview?${selectorQuery(selector)}`, {
    method: 'POST',
    headers: { 'X-ABS-CSRF': csrfToken() },
  });
  recoverIfStale(res.status);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `preview failed: ${res.status}`);
  }
  return (await res.json()) as PreviewResult;
}

/** Delete exactly the set a prior preview pinned under `handle`. */
export async function executeDelete(handle: string): Promise<ExecuteResult> {
  const res = await fetch(`/api/delete?handle=${encodeURIComponent(handle)}`, {
    method: 'DELETE',
    headers: { 'X-ABS-CSRF': csrfToken() },
  });
  recoverIfStale(res.status);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
    // A consumed/expired handle (server Control 4) reads as a clean message, not a crash.
    throw new Error(body.error ?? `delete failed: ${res.status}`);
  }
  return (await res.json()) as ExecuteResult;
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

/**
 * Show a modal confirmation dialog listing the previewed count + snippets, and
 * resolve `true` only if the user confirms the (irreversible) hard delete. The
 * `summary` line makes the scope explicit — for a capped search it must read as
 * "these N previewed items", never an uncapped total.
 */
export function confirmDelete(preview: PreviewResult, summary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = el('div', {
      class: 'delete-backdrop',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Confirmar exclusão de memória',
    });

    const close = (ok: boolean): void => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(false);
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });

    const list = el('ul', { class: 'delete-list' });
    for (const item of preview.items.slice(0, 12)) {
      list.append(
        el('li', { class: 'delete-item' }, [
          el('span', { class: 'delete-item-kind', 'data-type': item.kind }, [item.kind]),
          el('span', { class: 'delete-item-snippet' }, [item.snippet]),
        ]),
      );
    }
    const more = preview.items.length - Math.min(preview.items.length, 12);
    const extra = more > 0 ? [el('li', { class: 'delete-more' }, [`…and ${more} more`])] : [];

    const cancelBtn = el('button', { type: 'button', class: 'control toggle' }, ['cancelar']);
    const confirmBtn = el('button', { type: 'button', class: 'control delete-confirm' }, [
      `excluir ${preview.count}`,
    ]);
    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));

    const dialog = el('div', { class: 'delete-dialog overlay' }, [
      el('header', { class: 'delete-head' }, [
        el('span', { class: 'delete-title' }, ['excluir memória']),
        el('span', { class: 'delete-count' }, [
          `${preview.count} ${preview.count === 1 ? 'item' : 'itens'}`,
        ]),
      ]),
      el('p', { class: 'delete-summary' }, [summary]),
      el('ul', { class: 'delete-list-wrap' }, [list, ...extra]),
      el('p', { class: 'delete-warn' }, ['Exclusão permanente e irreversível.']),
      el('div', { class: 'delete-actions' }, [cancelBtn, confirmBtn]),
    ]);

    backdrop.append(dialog);
    document.body.append(backdrop);
    confirmBtn.focus();
  });
}
