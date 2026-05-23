/**
 * Per-harness session-id namespacing (W1, #67) — a TRUE LEAF module.
 *
 * Defines `isCodexTranscript`, `harnessForPayload`, and `namespacedExternalId`,
 * depending on NOTHING from `ingest.ts` or the hooks layer. `ingest.ts` imports
 * FROM here (one direction, no cycle); the dispatch chokepoint imports the two
 * helpers via the ingest barrel.
 *
 * The store keys sessions + bindings by `external_id`. With two harnesses on one
 * DB, a Codex `session_meta.id` and a Claude `sessionId` could (astronomically
 * rarely) collide and merge into one store session. Namespacing makes that
 * structurally impossible. Migration-safety: Claude keeps its BARE id (every
 * existing row + binding resolves unchanged); every other harness is prefixed
 * `<harnessId>:`.
 */

/** True when the path is a Codex rollout transcript (drives parser + namespace). */
export function isCodexTranscript(absPath: string): boolean {
  return (
    absPath.includes('/.codex/sessions/') ||
    /\/rollout-\d{4}-\d{2}-\d{2}T[\d-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(
      absPath,
    )
  );
}

/**
 * Namespace a harness session id for storage (W1, #67). Claude Code keeps its
 * BARE id (migration-safe: existing rows + bindings written before namespacing
 * resolve unchanged). Every other harness is prefixed `<harnessId>:` so two
 * harnesses' colliding raw ids never merge into one store session.
 */
export function namespacedExternalId(harnessId: string, rawSessionId: string): string {
  return harnessId === 'claude-code' ? rawSessionId : `${harnessId}:${rawSessionId}`;
}

/**
 * Derive the harness id from a hook payload's transcript path (C-NEW-1). Every
 * hook payload carries `transcriptPath`, and the path shape is the single source
 * of harness truth. Called once at the dispatch chokepoint (and by ingest for the
 * path-derived capture namespace). No transcript path → assume Claude (bare), the
 * safe default.
 */
export function harnessForPayload(payload: { transcriptPath?: string }): string {
  return payload.transcriptPath && isCodexTranscript(payload.transcriptPath)
    ? 'codex'
    : 'claude-code';
}
