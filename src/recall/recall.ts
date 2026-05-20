/**
 * Semantic recall (issue #6) — hybrid vector + keyword search over the store.
 *
 * Flow: query → embed → vector KNN (sqlite-vec) ⊕ FTS keyword search (FTS5),
 * fused with Reciprocal Rank Fusion → ranked observations. This is the read side
 * of the `embed → persist → recall` contract; the persisted index built by the
 * Indexer (#5) is what makes the result survive a restart.
 */
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MemoryStore, Observation } from '../store/index.js';
import { DEFAULT_RRF_K, reciprocalRankFusion } from './rrf.js';

export interface RecallOptions {
  /** Max results to return. */
  limit?: number;
  /** Candidate pool pulled from each index before fusion (defaults to limit * 5). */
  candidates?: number;
  /** RRF damping constant. */
  rrfK?: number;
}

export interface RecallHit {
  observation: Observation;
  score: number;
  vectorRank?: number;
  ftsRank?: number;
}

/**
 * Turn free text into a safe FTS5 MATCH expression: word tokens OR-ed together,
 * each quoted so punctuation/operators in the query can't break the parser or
 * inject FTS syntax. Returns null when there is nothing searchable.
 */
export function toFtsQuery(text: string): string | null {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of tokens) {
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    terms.push(`"${t}"`);
  }
  return terms.length > 0 ? terms.join(' OR ') : null;
}

export class Recall {
  private readonly store: MemoryStore;
  private readonly provider: EmbeddingProvider;

  constructor(store: MemoryStore, provider: EmbeddingProvider) {
    this.store = store;
    this.provider = provider;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallHit[]> {
    const limit = options.limit ?? 10;
    const candidates = options.candidates ?? Math.max(limit * 5, 20);
    const rrfK = options.rrfK ?? DEFAULT_RRF_K;

    const [queryVector] = await this.provider.embed([query]);
    const vectorIds = queryVector ? this.store.knn(queryVector, candidates).map((h) => h.id) : [];

    const ftsExpr = toFtsQuery(query);
    const ftsIds = ftsExpr ? this.store.searchFts(ftsExpr, candidates).map((h) => h.id) : [];

    const fused = reciprocalRankFusion(
      [
        { name: 'vector', ids: vectorIds },
        { name: 'fts', ids: ftsIds },
      ],
      rrfK,
    );

    const hits: RecallHit[] = [];
    for (const f of fused) {
      if (hits.length >= limit) break;
      const observation = this.store.getObservation(f.id);
      if (!observation) continue; // index drifted ahead of rows — skip defensively
      hits.push({
        observation,
        score: f.score,
        vectorRank: f.ranks.vector,
        ftsRank: f.ranks.fts,
      });
    }
    return hits;
  }
}
