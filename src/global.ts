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
import type { MemoryStore } from './store/index.js';

/** Reserved external_id AND project label for the global brain. Never a real cwd slug. */
export const GLOBAL_PROJECT = '__global__';

/** Lazily get-or-create the reserved global session; returns its store id. */
export function getOrCreateGlobalSession(store: MemoryStore): number {
  const existing = store.getSessionByExternalId(GLOBAL_PROJECT);
  if (existing) return existing.id;
  return store.createSession({ externalId: GLOBAL_PROJECT, project: GLOBAL_PROJECT });
}
