/**
 * Delete types — the contract for selective hard-delete of memories (Phase A).
 *
 * Hard-delete is destructive and irreversible, so the design splits it into a
 * read-only `preview` (resolve a selector to a concrete, pinned id set) and an
 * `execute` step that deletes ONLY that pinned set. Pinning the ids at preview
 * time closes the TOCTOU window: a search/selector is never re-run at execute,
 * so observations that landed in between can't be swept up by surprise.
 *
 * Two entry styles share the one core (see `index.ts`): MCP/UI mint a `handle`
 * (preview returns it; execute consumes it from a TTL cache so a replay can't
 * re-run a destructive delete), while the CLI pins its own ids in-process and
 * deletes them directly — no cache needed because the whole flow is one process.
 */

/**
 * What to delete. Exactly one shape per call:
 *   - `byIds`     — explicit observation ids (deduped; unknown ids reported, not dropped).
 *   - `bySession` — every observation of one session.
 *   - `byProject` — every observation of every session with this project. `null`
 *                   targets sessions whose project IS NULL (distinct from the
 *                   literal string `'null'`).
 *   - `bySearch`  — observations matched by FTS keyword recall (NO embedding); the
 *                   resolved set is capped by the FTS `limit`.
 */
export type DeleteSelector =
  | { byIds: number[] }
  | { bySession: number }
  | { byProject: string | null }
  | { bySearch: { query: string; limit?: number } };

/** One observation in a preview — enough to let a human confirm WHAT will go. */
export interface DeletePreviewItem {
  id: number;
  /** The observation's `kind` (user/assistant/tool/decision/lesson/…). */
  kind: string;
  /** Truncated content (~80 chars) so the preview payload stays light. */
  snippet: string;
  sessionId: number;
  createdAt: string;
}

/**
 * The result of a read-only `preview`. `count` reflects the RESOLVED set (for
 * `bySearch` this is the capped set, not a hypothetical total). The `handle` is a
 * crypto-random token that pins this exact id set in the delete cache for a TTL;
 * `execute(memory, handle)` consumes it. `notFound` carries `byIds` entries that
 * don't exist — counted, never silently dropped.
 */
export interface DeletePreview {
  handle: string;
  count: number;
  items: DeletePreviewItem[];
  notFound: number[];
  selectorEcho: DeleteSelector;
}

/** The resolved id set without minting a handle — the CLI's preview shape. */
export interface ResolvedSelection {
  /** Concrete, deduped, ordered observation ids that would be deleted. */
  ids: number[];
  items: DeletePreviewItem[];
  notFound: number[];
  selectorEcho: DeleteSelector;
}

/** The outcome of an `execute`: which ids actually went, which were already gone. */
export interface DeleteResult {
  deleted: number[];
  notFound: number[];
}

/** Machine-readable refusal reason when a handle can't be honoured. */
export type DeleteRefusalReason = 'unknown-handle';

/**
 * Thrown by `execute` when the handle is unknown, expired, or already consumed.
 * Carries a stable `reason` code so MCP/UI can branch without string-matching.
 */
export class DeleteRefusalError extends Error {
  readonly reason: DeleteRefusalReason;
  constructor(reason: DeleteRefusalReason, message?: string) {
    super(message ?? `delete refused: ${reason}`);
    this.name = 'DeleteRefusalError';
    this.reason = reason;
  }
}
