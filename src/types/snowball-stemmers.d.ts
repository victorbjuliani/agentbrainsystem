/**
 * Ambient types for `snowball-stemmers` (a JS port of the Snowball stemmers).
 * The package ships no types and is CommonJS, so we declare the slice we use:
 * a factory that builds a per-language stemmer. See `src/recall/stemming.ts`.
 */
declare module 'snowball-stemmers' {
  interface Stemmer {
    /** Reduce a word to its stem (e.g. english "running" → "run"). */
    stem(word: string): string;
  }
  interface SnowballFactory {
    /** Build a stemmer for a Snowball algorithm name (e.g. "english", "portuguese"). */
    newStemmer(language: string): Stemmer;
    /** The supported algorithm names. */
    algorithms(): string[];
  }
  const factory: SnowballFactory;
  export = factory;
}
