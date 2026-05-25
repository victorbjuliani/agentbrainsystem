/**
 * Content-hash idempotence key (#105).
 *
 * Ingest is at-least-once (re-sync rewinds + a cross-process cursor race can
 * re-present the same lines). A stable hash of the identity tuple — (session,
 * content, source) — backs a UNIQUE index so a re-ingest of identical content is
 * a no-op INSERT instead of a duplicate row. Lives in its own module so both the
 * store (`createObservation`) and the migration backfill can share it without a
 * circular import.
 *
 * A NUL separator keeps the fields unambiguous (no delimiter can appear inside a
 * field), and `source` is normalized to '' when absent so present-vs-absent
 * source is a deterministic, distinct key.
 */
import { createHash } from 'node:crypto';

/** NUL separator — cannot appear inside a content/source field, so the join is unambiguous. */
const SEP = String.fromCharCode(0);

export function observationContentHash(
  sessionId: number,
  content: string,
  source: string | null | undefined,
): string {
  return createHash('sha256')
    .update(`${sessionId}${SEP}${content}${SEP}${source ?? ''}`)
    .digest('hex');
}
