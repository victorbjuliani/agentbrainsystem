/**
 * Global brain (#) — a curated, cross-project memory layer recalled on every
 * prompt alongside the project brain. It lives in the normal store as a single
 * RESERVED session whose external_id and project are both the sentinel below.
 *
 * Collision-free by construction: ingest only ever creates sessions with
 * external_id = a Claude Code session UUID and project = projectSlug(cwd) (always
 * begins with the path separator, `-…`). The literal `__global__` cannot be
 * produced by either path, so the reserved row never clashes with a real project.
 */
import type { Memory } from './memory.js';
import type { MemoryStore } from './store/index.js';

/** Reserved external_id AND project label for the global brain. Never a real cwd slug. */
export const GLOBAL_PROJECT = '__global__';

/** Lazily get-or-create the reserved global session; returns its store id. */
export function getOrCreateGlobalSession(store: MemoryStore): number {
  const existing = store.getSessionByExternalId(GLOBAL_PROJECT);
  if (existing) return existing.id;
  return store.createSession({ externalId: GLOBAL_PROJECT, project: GLOBAL_PROJECT });
}

/**
 * Kinds the curated global brain accepts — same vocabulary as `abs remember`
 * (decision|lesson|note). A curated promote never carries raw ingest kinds
 * (`user`/`assistant`/`tool_edit`) into the global layer; those normalize to `note`.
 */
const CURATED_KINDS = new Set(['decision', 'lesson', 'note']);

export interface PromoteArgs {
  id: number;
  /**
   * When present, file a curated COPY under the global brain (keeping the original
   * in its project) instead of moving the whole observation. Absent (`undefined`)
   * keeps the legacy move behavior; present-but-empty is rejected (caller error).
   */
  as?: string;
}

export interface PromoteResult {
  id: number;
  scope: 'global';
  applied: boolean;
  newId?: number;
  curated?: boolean;
  error?: string;
}

/**
 * Promote an observation into the cross-project global brain. Shared by the CLI
 * (`abs promote`) and the MCP `promote` tool so both stay byte-for-byte consistent.
 *
 *  - `as` absent → MOVE the whole observation into the global session (legacy).
 *  - `as` non-empty → file a NEW global observation containing EXACTLY that text and
 *    leave the original untouched. The curated copy inherits NO metadata from the
 *    original (it may hold project-specific or sensitive context) — only a
 *    `{ promotedFrom }` provenance pointer. This is the leak-safe path: promote only
 *    the reusable wording and leave the sensitive detail behind in the project.
 *
 * User-initiated only — never call on the agent's own initiative.
 */
export async function promoteAction(
  memory: Memory,
  { id, as }: PromoteArgs,
): Promise<PromoteResult> {
  const original = memory.store.getObservation(id);
  if (!original) return { id, scope: 'global', applied: false, error: `no observation ${id}` };

  const globalSession = getOrCreateGlobalSession(memory.store);

  if (as !== undefined) {
    const curated = as.trim();
    if (curated.length === 0) {
      return {
        id,
        scope: 'global',
        applied: false,
        error: 'curated text (--as) must not be empty',
      };
    }
    // Serialize behind any background index rebuild (the MCP server opens with a
    // background ensure) so the curated write can't be lost to a concurrent full
    // rebuild — the same guard rememberAction/recall use. No-op when `ready` is
    // undefined (the CLI opens synchronously).
    if (memory.ready) await memory.ready;
    const kind = CURATED_KINDS.has(original.kind) ? original.kind : 'note';
    const newId = await memory.indexer.write({
      sessionId: globalSession,
      kind,
      content: curated,
      metadata: { promotedFrom: id },
    });
    return { id, newId, scope: 'global', curated: true, applied: true };
  }

  memory.store.moveObservationToSession(id, globalSession);
  return { id, scope: 'global', applied: true };
}
