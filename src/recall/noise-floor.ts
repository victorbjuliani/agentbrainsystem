/**
 * Recall noise floor (#144) — suppress "best-of-the-junk" so a prompt with no genuinely
 * relevant memory injects NOTHING instead of a low-signal raw turn / config line.
 *
 * FTS bm25 has no normalized 0–1 score and its magnitude scales with the corpus, so an
 * absolute score threshold doesn't generalize. The signal that DOES generalize — measured
 * on the real 11k-observation store (spike, #144) — is **query-token coverage**: the
 * fraction of the query's content tokens the hit actually contains. Off-topic noise matched
 * exactly ONE (often common) token (coverage ≤ 0.25); on-topic hits matched most of the
 * query (≥ 0.75). A coverage floor at 0.4 separates them with a wide margin and is
 * corpus-independent (it's about overlap, not bm25 magnitude), and it needs no embedding —
 * so it works on the FTS-only per-prompt hook.
 *
 * The hybrid `recall()` path also has a normalized vector signal (cosine, derived from the
 * L2 distance of unit-normalized embeddings); a paraphrase can be a strong SEMANTIC match
 * with low literal overlap, so that path passes a hit on coverage OR cosine — coverage alone
 * would wrongly drop a genuine paraphrase. (The FTS-only path can't paraphrase-match anyway —
 * FTS only ever returns lexical hits — so coverage alone is safe there.)
 *
 * Both thresholds are env-tunable; setting either to 0 disables that leg of the floor.
 */

/** Fraction of query content tokens a hit must contain to clear the floor (0 disables). */
const DEFAULT_MIN_COVERAGE = 0.4;
/** Cosine a hybrid hit may instead clear (catches semantic paraphrase; 0 disables). */
const DEFAULT_MIN_COSINE = 0.45;

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  // A malformed override must not silently disable the floor; fall back to the default.
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Resolve the active floor thresholds from env (read per call so tests/users can tune). */
export function noiseFloorConfig(): { minCoverage: number; minCosine: number } {
  return {
    minCoverage: envNum('ABS_RECALL_MIN_COVERAGE', DEFAULT_MIN_COVERAGE),
    minCosine: envNum('ABS_RECALL_MIN_COSINE', DEFAULT_MIN_COSINE),
  };
}

/** Distinct content tokens of `text` — mirrors `toFtsQuery` (lowercase, letters/digits, len≥2). */
function contentTokens(text: string): Set<string> {
  const m = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  const out = new Set<string>();
  if (!m) return out;
  for (const t of m) if (t.length >= 2) out.add(t);
  return out;
}

/**
 * Fraction of the query's content tokens present in `content` (0..1). Returns 1 for a query
 * with no content tokens (nothing to floor on → never suppress).
 */
export function queryTokenCoverage(query: string, content: string): number {
  const q = [...contentTokens(query)];
  if (q.length === 0) return 1;
  const c = contentTokens(content);
  let matched = 0;
  for (const t of q) if (c.has(t)) matched += 1;
  return matched / q.length;
}

/** Cosine similarity of a unit-normalized embedding from its sqlite-vec L2 distance. */
export function cosineFromL2Distance(distance: number): number {
  return 1 - (distance * distance) / 2; // unit vectors: L2² = 2(1 − cos)
}

/**
 * True when a hit clears the noise floor: it covers enough of the query lexically, OR
 * (when a vector cosine is available) is a strong-enough semantic match. With both
 * thresholds disabled (0) every hit passes — the floor is off.
 */
export function passesNoiseFloor(
  query: string,
  content: string,
  cosine: number | undefined,
  cfg = noiseFloorConfig(),
): boolean {
  if (cfg.minCoverage <= 0 && cfg.minCosine <= 0) return true; // floor disabled
  if (cfg.minCoverage > 0 && queryTokenCoverage(query, content) >= cfg.minCoverage) return true;
  if (cfg.minCosine > 0 && cosine !== undefined && cosine >= cfg.minCosine) return true;
  return false;
}
