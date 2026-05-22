/**
 * Recall scope resolution (#47) — decide which project label to scope recall by,
 * or `undefined` for store-wide. The whole point is to stop project B's memory
 * leaking into a project A session, so the resolved label MUST equal the label
 * ingest actually stored in `sessions.project` — never a freshly recomputed slug,
 * or a worktree/relabeled session would scope to a label matching zero rows
 * (silent starvation). Resolution order, stored-label first:
 *
 *   1. global scope → undefined (no filter; the opt-out).
 *   2. a `set` decision binding for the session → its project (#50-52:
 *      `setSessionProject` UPDATEs `sessions.project` to exactly this label).
 *   3. the session's own stored row → its `project` (the exact stored label).
 *   4. the cwd slug → `projectSlug(cwd)`, canonical and byte-identical to what
 *      ingest writes (ingest derives the project from each line's `cwd`), so a
 *      not-yet-ingested current session scopes to the same slug its future rows
 *      and its sibling sessions in the same project already use — even when the
 *      transcript dir uses a different encoding (old space/underscore vs new
 *      all-hyphen) of the same cwd.
 *   5. the transcript-dir name → `basename(dirname(transcriptPath))`, fallback
 *      for the rare case with no cwd (only an older line that carried none).
 *   6. nothing resolvable → undefined (degrade to store-wide for this call).
 */
import { basename, dirname } from 'node:path';
import { readBinding } from '../ingest/index.js';
import { projectSlug } from '../optimize/targets.js';
import type { MemoryStore } from '../store/index.js';

/** Recall scope: project-isolated (default) or store-wide. */
export type RecallScope = 'project' | 'global';

/** Inputs for {@link resolveRecallProject}. All optional except `scope`. */
export interface RecallScopeInput {
  scope: RecallScope;
  /** Claude Code session id (keys the binding + the stored session row). */
  sessionId?: string;
  /** Hook payload transcript path — the exact file ingest derives the label from. */
  transcriptPath?: string;
  /** Working directory — last-resort slug source when no transcript is available. */
  cwd?: string;
}

export function resolveRecallProject(
  store: MemoryStore,
  input: RecallScopeInput,
): string | undefined {
  if (input.scope === 'global') return undefined;

  const { sessionId, transcriptPath, cwd } = input;

  if (sessionId) {
    const binding = readBinding(store, sessionId);
    if (binding?.action === 'set') return binding.project;
    const existing = store.getSessionByExternalId(sessionId);
    if (existing?.project) return existing.project;
  }

  if (cwd) return projectSlug(cwd);
  if (transcriptPath) return basename(dirname(transcriptPath));
  return undefined;
}
