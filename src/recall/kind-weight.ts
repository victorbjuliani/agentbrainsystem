import { CURATED_KINDS } from '../global.js';

/**
 * Re-rank weight that lifts curated/durable observations above raw ingest turns in the
 * recall ranking (#141). Durable = `CURATED_KINDS` (`decision`/`lesson`/`note`) — the same
 * vocabulary the global brain and `abs remember` accept; raw = everything else
 * (`user`/`assistant`/`tool…`).
 *
 * It is a MULTIPLIER on a relevance score, NOT a hard filter: a raw turn still outranks a
 * durable one when the durable one matches the query less well (its weight applies to a
 * smaller relevance base) or is absent from the candidate pool entirely. With the
 * reciprocal-rank base `1 / (DEFAULT_RRF_K + pos)` used by `recallFts`, `2.5` is enough to
 * lift a durable hit from the worst candidate-pool position above the best raw hit — so a
 * durable observation that lexically matched reliably reaches the top (the #141 goal).
 */
export const DURABLE_KIND_WEIGHT = 2.5;

/** Multiplier for `kind`: `DURABLE_KIND_WEIGHT` for curated kinds, `1` for everything else. */
export function kindWeight(kind: string): number {
  return CURATED_KINDS.has(kind) ? DURABLE_KIND_WEIGHT : 1;
}
