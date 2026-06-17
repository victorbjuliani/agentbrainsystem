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

/**
 * High-frequency function words (EN + PT, the store's two languages; a few ES) that carry no
 * topic signal. They are stripped from the QUERY before computing coverage so a verbose
 * natural-language prompt — "can you remind me what we decided about Coupa OAuth migration?" —
 * isn't penalized: without this, the 8 filler words inflate the denominator and a memory that
 * matches all 3 topic words still scores 3/11 < 0.4 and is wrongly dropped (Codex P1, #144).
 */
const STOPWORDS = new Set([
  // English
  'the',
  'and',
  'for',
  'are',
  'you',
  'your',
  'can',
  'could',
  'would',
  'should',
  'what',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'how',
  'why',
  'this',
  'that',
  'these',
  'those',
  'with',
  'from',
  'about',
  'into',
  'than',
  'then',
  'them',
  'they',
  'their',
  'there',
  'here',
  'have',
  'has',
  'had',
  'was',
  'were',
  'will',
  'did',
  'does',
  'done',
  'been',
  'being',
  'his',
  'her',
  'its',
  'our',
  'out',
  'not',
  'but',
  'all',
  'any',
  'some',
  'more',
  'most',
  'just',
  'like',
  'get',
  'got',
  'let',
  'me',
  'my',
  'we',
  'us',
  'do',
  'is',
  'it',
  'to',
  'of',
  'in',
  'on',
  'or',
  'as',
  'at',
  'be',
  'by',
  'an',
  'remind',
  'tell',
  'please',
  'know',
  'want',
  'need',
  'thing',
  'things',
  // Portuguese / Spanish
  'que',
  'com',
  'para',
  'por',
  'uma',
  'um',
  'os',
  'as',
  'da',
  'de',
  'do',
  'na',
  'no',
  'nas',
  'nos',
  'foi',
  'ser',
  'sao',
  'são',
  'mais',
  'sobre',
  'como',
  'quando',
  'onde',
  'qual',
  'quais',
  'voce',
  'você',
  'eu',
  'ele',
  'ela',
  'isso',
  'este',
  'esta',
  'esse',
  'essa',
  'tem',
  'sem',
  'meu',
  'minha',
  'lembra',
  'sobre',
  'fazer',
  'preciso',
  'quero',
  'los',
  'las',
  'una',
  'con',
  'del',
  'que',
]);

/** Distinct content tokens of `text` — mirrors `toFtsQuery` (lowercase, letters/digits, len≥2). */
function contentTokens(text: string): Set<string> {
  const m = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  const out = new Set<string>();
  if (!m) return out;
  for (const t of m) if (t.length >= 2) out.add(t);
  return out;
}

/**
 * Fraction of the query's TOPIC tokens (content tokens minus stopwords) present in `content`
 * (0..1). Returns 1 when the query has no topic tokens (nothing meaningful to floor on → never
 * suppress). Stopword stripping is applied only to the query's denominator — a topic token of
 * the query is "covered" iff it appears anywhere in the hit content.
 */
export function queryTokenCoverage(query: string, content: string): number {
  const q = [...contentTokens(query)].filter((t) => !STOPWORDS.has(t));
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
 * (when a vector cosine is available) is a strong-enough semantic match.
 *
 * A hit passes if it clears ANY leg that is both ENABLED (threshold > 0) and APPLICABLE
 * (cosine is only applicable when a vector cosine was supplied). When NO leg is enabled+
 * applicable there is nothing to floor on, so the hit passes — critically, disabling the
 * coverage leg (`ABS_RECALL_MIN_COVERAGE=0`) on the FTS-only path (no cosine) must let recall
 * through, not suppress everything because the default cosine threshold can never be met
 * there (Codex P2, #144).
 */
export function passesNoiseFloor(
  query: string,
  content: string,
  cosine: number | undefined,
  cfg = noiseFloorConfig(),
): boolean {
  const coverageApplies = cfg.minCoverage > 0;
  const cosineApplies = cfg.minCosine > 0 && cosine !== undefined;
  if (!coverageApplies && !cosineApplies) return true; // no floor leg applies → nothing to suppress
  if (coverageApplies && queryTokenCoverage(query, content) >= cfg.minCoverage) return true;
  if (cosineApplies && (cosine as number) >= cfg.minCosine) return true;
  return false;
}
