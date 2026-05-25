/**
 * Cross-language query stemming for the UI's forgiving search (follow-up to #129).
 *
 * The store is bilingual — memories in Portuguese, technical terms in English —
 * so a single-language stemmer would distort one of them. English is the default
 * (the base coverage), with Portuguese and Spanish added best-effort so a query
 * term reaches its whole word family regardless of language.
 *
 * This is OPT-IN and lives off the recall hot path: only `toFtsQuery(..., { stem })`
 * calls it (the UI search), never recall's per-prompt FTS leg, which keeps its
 * exact, validated semantics (#129).
 */
import factory from 'snowball-stemmers';

// English first (the default); pt/es are extra coverage for the bilingual store.
const LANGUAGES = ['english', 'portuguese', 'spanish'] as const;

// Building a stemmer is cheap, but do it once — search fires per debounced keystroke.
let stemmers: { stem(word: string): string }[] | null = null;
function getStemmers(): { stem(word: string): string }[] {
  if (!stemmers) stemmers = LANGUAGES.map((lang) => factory.newStemmer(lang));
  return stemmers;
}

/**
 * Expand a token into the original plus its distinct stems across the supported
 * languages. The original is always kept (so an already-short or proper-noun token
 * still matches itself); stems shorter than 2 chars are dropped so a query can't
 * collapse to an over-broad `"a"*`. Order is stable: original, then en/pt/es stems.
 */
export function stemVariants(token: string): string[] {
  const out = new Set<string>([token]);
  for (const stemmer of getStemmers()) {
    const stem = stemmer.stem(token);
    if (stem.length >= 2) out.add(stem);
  }
  return [...out];
}
