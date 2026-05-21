/**
 * Selective hard-delete core (Phase A) — the ONE engine the CLI, MCP and UI drive.
 *
 * Hard-delete is destructive, so the flow is two-phase: a read-only `preview`
 * resolves a selector to a concrete, deduped, ordered observation-id set, and
 * `execute` deletes ONLY that pinned set. Resolution (search, project scan, …)
 * happens exactly once — at preview — and is never re-run at execute. That closes
 * the TOCTOU window: observations that arrive between preview and execute cannot
 * be swept into a delete the user never confirmed.
 *
 * Two entry styles, one core:
 *   - MCP/UI: `preview` mints a crypto-random `handle` that pins the id set in a
 *     module-level TTL cache; `execute(memory, handle)` looks it up and CONSUMES
 *     it (removed before any row is deleted) so a replayed handle can't re-run a
 *     destructive delete.
 *   - CLI: `previewSelector` resolves ids WITHOUT minting a handle, and
 *     `executeIds` deletes a caller-pinned id list directly — the whole
 *     preview→confirm→delete loop lives in one process, so no cache is needed.
 *
 * C1 (no cursor clamp): we deliberately do NOT touch `optimize:cursorObsId`. The
 * staleness flag computes `pending = COUNT(id > cursor)`, so deleting rows above
 * the cursor lowers `pending` on its own and deleting rows below leaves it
 * unchanged — the heuristic self-corrects without us mutating the cursor.
 */
import { randomUUID } from 'node:crypto';
import type { Memory } from '../memory.js';
import type {
  DeletePreview,
  DeletePreviewItem,
  DeleteResult,
  DeleteSelector,
  ResolvedSelection,
} from './types.js';
import { DeleteRefusalError } from './types.js';

/** Snippet length for preview items — mirrors the UI graph label cap. */
const SNIPPET_MAX = 80;

/** How long a minted handle stays valid before it's treated as expired (5 min). */
const HANDLE_TTL_MS = 5 * 60 * 1000;

/** Hard cap on cached handles; minting over this evicts the oldest entry. */
const MAX_CACHE_ENTRIES = 256;

/** A pinned delete plan parked in the cache between preview and execute. */
interface CacheEntry {
  ids: number[];
  selectorEcho: DeleteSelector;
  createdAt: number;
}

/**
 * Module-level handle → pinned-plan cache. Insertion order is preserved by `Map`,
 * so the oldest entry is always `keys().next()` — used for both TTL pruning and
 * the max-entries eviction. Process-local by design: a delete plan never crosses
 * process boundaries (the CLI doesn't use this; MCP/UI live in one server).
 */
const deleteCache = new Map<string, CacheEntry>();

/** Truncate content to keep preview payloads light (mirrors ui/graph truncate). */
function truncate(text: string): string {
  return text.length <= SNIPPET_MAX ? text : `${text.slice(0, SNIPPET_MAX - 1)}…`;
}

/** Drop cache entries older than the TTL relative to `now`. */
function pruneExpired(now: number): void {
  for (const [handle, entry] of deleteCache) {
    if (now - entry.createdAt >= HANDLE_TTL_MS) deleteCache.delete(handle);
  }
}

/** Evict oldest entries until the cache is within its bound. */
function evictOverflow(): void {
  while (deleteCache.size > MAX_CACHE_ENTRIES) {
    const oldest = deleteCache.keys().next().value;
    if (oldest === undefined) break;
    deleteCache.delete(oldest);
  }
}

/** Build the resolved observation ids for a session, ordered ascending by id. */
function idsForSession(memory: Memory, sessionId: number): number[] {
  return memory.store.listObservations({ sessionId }).map((o) => o.id);
}

/**
 * Resolve the observation ids for a project (or NULL project). Reuses store reads
 * only — never deletes here. Sessions are listed, filtered by project, then each
 * session's observations are gathered in id order.
 */
function idsForProject(memory: Memory, project: string | null): number[] {
  const sessions = memory.store
    .listSessions()
    .filter((s) => (project === null ? s.project === undefined : s.project === project));
  const ids: number[] = [];
  for (const session of sessions) ids.push(...idsForSession(memory, session.id));
  return ids;
}

/**
 * Resolve a selector to a concrete, deduped, ordered selection — the shared core
 * of both `preview` (which then mints a handle) and `previewSelector` (which does
 * not). READ-ONLY: nothing is deleted. `notFound` only ever applies to `byIds`
 * (an id the user named that doesn't exist); the other selectors derive their ids
 * from existing rows, so there is nothing to "not find".
 */
function resolve(memory: Memory, selector: DeleteSelector): ResolvedSelection {
  let rawIds: number[];
  const notFound: number[] = [];

  if ('byIds' in selector) {
    const seen = new Set<number>();
    const existing: number[] = [];
    for (const id of selector.byIds) {
      if (seen.has(id)) continue; // dedupe — count an id once
      seen.add(id);
      if (memory.store.getObservation(id) === null) notFound.push(id);
      else existing.push(id);
    }
    rawIds = existing;
  } else if ('bySession' in selector) {
    rawIds = idsForSession(memory, selector.bySession);
  } else if ('byProject' in selector) {
    rawIds = idsForProject(memory, selector.byProject);
  } else {
    // bySearch — FTS keyword recall ONLY (no embed). The set is capped by `limit`;
    // `count` therefore reflects the capped/resolved set, not a hypothetical total.
    const hits = memory.recall.recallFts(
      selector.bySearch.query,
      selector.bySearch.limit !== undefined ? { limit: selector.bySearch.limit } : {},
    );
    rawIds = hits.map((h) => h.observation.id);
  }

  // Dedupe + stable ascending order so the pinned set is deterministic. (byIds is
  // already deduped and order-preserving; sorting unifies every selector's shape.)
  const ids = [...new Set(rawIds)].sort((a, b) => a - b);

  const items: DeletePreviewItem[] = [];
  for (const id of ids) {
    const obs = memory.store.getObservation(id);
    if (!obs) continue; // resolved set drifted (concurrent delete) — skip defensively
    items.push({
      id: obs.id,
      kind: obs.kind,
      snippet: truncate(obs.content),
      sessionId: obs.sessionId,
      createdAt: obs.createdAt,
    });
  }

  return { ids, items, notFound, selectorEcho: selector };
}

/**
 * Resolve a selector to a concrete selection WITHOUT minting a handle. The CLI
 * uses this to show a preview, then passes the returned `ids` to `executeIds`
 * after the user confirms — all in one process, no cache.
 */
export function previewSelector(memory: Memory, selector: DeleteSelector): ResolvedSelection {
  return resolve(memory, selector);
}

/**
 * READ-ONLY preview for MCP/UI. Resolves the selector, mints a crypto-random
 * handle, and parks the pinned id set in the TTL cache. `execute(memory, handle)`
 * later deletes exactly that set. Returns the items + a `count` of the resolved
 * (for `bySearch`, capped) set.
 */
export function preview(memory: Memory, selector: DeleteSelector): DeletePreview {
  const now = Date.now();
  pruneExpired(now);

  const resolved = resolve(memory, selector);
  const handle = randomUUID();
  deleteCache.set(handle, {
    ids: resolved.ids,
    selectorEcho: resolved.selectorEcho,
    createdAt: now,
  });
  evictOverflow();

  return {
    handle,
    count: resolved.ids.length,
    items: resolved.items,
    notFound: resolved.notFound,
    selectorEcho: resolved.selectorEcho,
  };
}

/**
 * Delete the pinned set of observation ids (the shared deletion mechanic). Each
 * id goes through `deleteObservation` (which prunes its vec0 + fts5 rows); ids
 * already gone land in `notFound`. A final `pruneIndexOrphans` is a defensive
 * sweep so no index row can outlive its observation. NO cursor clamp (C1).
 */
function deletePinned(memory: Memory, ids: number[]): DeleteResult {
  const deleted: number[] = [];
  const notFound: number[] = [];
  const tx = memory.store.transaction(() => {
    for (const id of ids) {
      if (memory.store.getObservation(id) === null) {
        notFound.push(id);
        continue;
      }
      memory.store.deleteObservation(id);
      deleted.push(id);
    }
    // Defensive: guarantee index rows never outlive their observation rows.
    memory.store.pruneIndexOrphans();
  });
  tx();
  return { deleted, notFound };
}

/**
 * Delete a caller-pinned id list directly, skipping the handle cache. The CLI
 * pins its own ids from a `previewSelector` it just ran in the same process, so
 * there is no replay/TOCTOU surface a cache would guard against.
 */
export function executeIds(memory: Memory, ids: number[]): DeleteResult {
  return deletePinned(memory, ids);
}

/**
 * Execute a previewed delete by handle (MCP/UI). The handle is CONSUMED first —
 * removed from the cache BEFORE any row is deleted — so a replayed handle hits
 * `unknown-handle` and cannot re-run a destructive delete. An expired handle
 * (older than the TTL) is likewise refused. Only the pinned id set is touched;
 * recall is never re-run, so the delete is exactly what was previewed (no TOCTOU).
 */
export function execute(memory: Memory, handle: string): DeleteResult {
  const now = Date.now();
  pruneExpired(now);

  const entry = deleteCache.get(handle);
  if (entry === undefined) {
    throw new DeleteRefusalError('unknown-handle');
  }
  // Consume atomically: delete the handle before deleting rows so a replay (even
  // a concurrent one) can't find it again.
  deleteCache.delete(handle);

  return deletePinned(memory, entry.ids);
}

/**
 * Test-only: clear the handle cache so suites don't leak pinned plans across
 * cases. Not part of the public delete surface — exported for tests only.
 */
export function __clearDeleteCacheForTests(): void {
  deleteCache.clear();
}
