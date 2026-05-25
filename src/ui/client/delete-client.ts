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

import { t } from './i18n.js';

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
    // a11y (ADR-0008): a destructive, irreversible action must (1) trap focus inside
    // the dialog so Tab can't reach the graph chrome behind the aria-modal surface,
    // (2) focus the SAFE action (Cancel) on open so a reflexive Enter cancels rather
    // than deletes, and (3) return focus to the trigger on close. Title/count are
    // wired via aria-labelledby; the scope summary + irreversibility warning via
    // aria-describedby, so a screen reader announces WHAT and that it cannot be undone.
    const titleId = 'delete-title';
    const countId = 'delete-count';
    const summaryId = 'delete-summary';
    const warnId = 'delete-warn';

    // B3: remember what had focus so we can restore it when the dialog closes.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const backdrop = el('div', {
      class: 'delete-backdrop',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': `${titleId} ${countId}`,
      'aria-describedby': `${summaryId} ${warnId}`,
    });

    const close = (ok: boolean): void => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      // B3: return focus to the trigger (trash / "excluir busca") if it's still around.
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
      resolve(ok);
    };

    // B1: focusable elements inside the dialog, in DOM order, for the Tab trap.
    const focusables = (): HTMLElement[] =>
      Array.from(
        backdrop.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => !node.hasAttribute('disabled'));

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        close(false);
        return;
      }
      // B1: cycle Tab/Shift+Tab between the first and last focusable so focus never
      // escapes the modal into the graph chrome behind it.
      if (e.key === 'Tab') {
        const items = focusables();
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (!backdrop.contains(active)) {
          // Focus drifted out (e.g. nothing focused yet) — pull it back in.
          e.preventDefault();
          first.focus();
        }
      }
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
          // M3: the snippet is truncated with ellipsis — expose the full text on hover
          // so the user can see what they're about to irreversibly delete.
          el('span', { class: 'delete-item-snippet', title: item.snippet }, [item.snippet]),
        ]),
      );
    }
    const more = preview.items.length - Math.min(preview.items.length, 12);
    const extra =
      more > 0 ? [el('li', { class: 'delete-more' }, [t('deleteMoreN', { n: more })])] : [];

    // L1: surface the preview's own notFound (ids that no longer exist) so the dialog
    // doesn't silently drop them — the count above already excludes them.
    if (preview.notFound.length > 0) {
      extra.push(
        el('li', { class: 'delete-notfound' }, [
          t('deleteNotFoundN', { n: preview.notFound.length }),
        ]),
      );
    }

    // M1 + B2: Cancel is the calm default (and gets initial focus); the destructive
    // confirm stays distinct (danger-colored) but is NOT styled as the focal primary.
    const cancelBtn = el('button', { type: 'button', class: 'control toggle delete-cancel' }, [
      t('deleteCancel'),
    ]);
    const confirmBtn = el('button', { type: 'button', class: 'control delete-confirm' }, [
      t('deleteConfirmN', { n: preview.count }),
    ]);
    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));

    const dialog = el('div', { class: 'delete-dialog overlay' }, [
      el('header', { class: 'delete-head' }, [
        el('span', { class: 'delete-title', id: titleId }, [t('deleteDialogTitle')]),
        el('span', { class: 'delete-count', id: countId }, [
          t('deleteCountN', { n: preview.count }),
        ]),
      ]),
      el('p', { class: 'delete-summary', id: summaryId }, [summary]),
      el('ul', { class: 'delete-list-wrap' }, [list, ...extra]),
      el('p', { class: 'delete-warn', id: warnId }, [t('deleteWarn')]),
      el('div', { class: 'delete-actions' }, [cancelBtn, confirmBtn]),
    ]);

    backdrop.append(dialog);
    document.body.append(backdrop);
    // B2: focus the SAFE action, never the destructive one.
    cancelBtn.focus();
  });
}
