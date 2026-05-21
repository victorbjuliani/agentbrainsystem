/**
 * Selective hard-delete public surface (Phase A).
 *
 * One core, two entry styles (see `delete.js`):
 *   - MCP/UI (handle-pinned, cross-call):
 *       `preview(memory, selector)` → mint a handle pinning the resolved id set.
 *       `execute(memory, handle)`   → consume the handle and delete that set.
 *   - CLI (in-process, no cache):
 *       `previewSelector(memory, selector)` → resolve ids without a handle.
 *       `executeIds(memory, ids)`           → delete a caller-pinned id list.
 *
 * Both delete ONLY a pinned id set (recall is never re-run at execute), which
 * closes the TOCTOU window. The cursor is intentionally NOT clamped (C1) — the
 * staleness `pending = COUNT(id > cursor)` heuristic self-corrects.
 */
export {
  execute,
  executeIds,
  preview,
  previewSelector,
} from './delete.js';
export type {
  DeletePreview,
  DeletePreviewItem,
  DeleteRefusalReason,
  DeleteResult,
  DeleteSelector,
  ResolvedSelection,
} from './types.js';
export { DeleteRefusalError } from './types.js';
