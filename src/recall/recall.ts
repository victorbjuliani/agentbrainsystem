/**
 * Semantic recall (issue #6) — hybrid vector + keyword search over the store.
 *
 * Flow: query → embed → vector KNN (sqlite-vec) ⊕ FTS keyword search (FTS5),
 * fused with Reciprocal Rank Fusion → ranked observations. This is the read side
 * of the `embed → persist → recall` contract; the persisted index built by the
 * Indexer (#5) is what makes the result survive a restart.
 */
import type { EmbeddingProvider } from '../embedding/index.js';
import { GLOBAL_PROJECT } from '../global.js';
import type { AnchorState, MemoryStore, Observation } from '../store/index.js';
import { DEFAULT_RRF_K, reciprocalRankFusion } from './rrf.js';

export interface RecallOptions {
  /** Max results to return. */
  limit?: number;
  /** Candidate pool pulled from each index before fusion (defaults to limit * 5). */
  candidates?: number;
  /** RRF damping constant. */
  rrfK?: number;
  /**
   * Restrict recall to observations filed under this project (#47). Undefined →
   * store-wide recall (the previous behavior). Both index legs are filtered so
   * cross-project memory cannot leak into a scoped session.
   */
  project?: string;
  /** Also include the cross-project global brain (`__global__`) alongside the project (#). */
  includeGlobal?: boolean;
}

export interface RecallHit {
  observation: Observation;
  score: number;
  vectorRank?: number;
  ftsRank?: number;
  /**
   * Verifiability of this fact against ground truth (the E layer, #27).
   * Set by `annotateFreshness`; absent means not-yet-annotated or a fact with
   * no code anchors (conversational). `stale` is a trust warning.
   */
  anchorState?: AnchorState;
  /**
   * True when this fact was verified on a branch other than the current one
   * (FR-C1, #31) — context that may not apply on this branch. Set by
   * `annotateFreshness` only when a current branch is supplied.
   */
  crossBranch?: boolean;
  /** True when this hit comes from the cross-project global brain (#). */
  global?: boolean;
}

export interface RecallFtsOptions {
  /** Max results to return. Default 8. */
  limit?: number;
  /** Restrict to observations filed under this project (#47). Undefined → store-wide. */
  project?: string;
  /** Also include the global brain (`__global__`) alongside the project (#). */
  includeGlobal?: boolean;
}

/**
 * Turn free text into a safe FTS5 MATCH expression: word tokens OR-ed together,
 * each quoted so punctuation/operators in the query can't break the parser or
 * inject FTS syntax. Returns null when there is nothing searchable. With
 * `{ prefix: true }` each token becomes a prefix match (`"migrat"*`) — opt-in for
 * the UI's forgiving search; recall keeps the default exact match (#129).
 */
export function toFtsQuery(text: string, opts: { prefix?: boolean } = {}): string | null {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of tokens) {
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    // `prefix` opts a token into FTS5 prefix matching (`"migrat"*` → migration,
    // migrations). The UI search uses it for forgiving keyword lookup (#129); recall
    // leaves it OFF so its per-prompt FTS leg keeps its exact, validated semantics.
    terms.push(opts.prefix ? `"${t}"*` : `"${t}"`);
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

    const { project, includeGlobal } = options;
    const [queryVector] = await this.provider.embed([query]);
    const vectorIds = queryVector
      ? this.store.knn(queryVector, candidates, project, includeGlobal).map((h) => h.id)
      : [];

    const ftsExpr = toFtsQuery(query);
    const ftsIds = ftsExpr
      ? this.store.searchFts(ftsExpr, candidates, project, includeGlobal).map((h) => h.id)
      : [];

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

  /**
   * FTS-only recall — the fast path for the per-prompt hook (#19). Deliberately
   * does NOT call `provider.embed`, so it never pays the local model's cold-load
   * tax and can never hit the first-ever-download landmine (ADR-0005). It is the
   * lexical leg of `recall` in isolation: `toFtsQuery` → `store.searchFts`.
   *
   * `ftsRank` is the raw FTS5 rank (more negative = better); callers that want a
   * descending "best first" score can negate it. Returns at most `limit` hits.
   */
  recallFts(query: string, options: RecallFtsOptions = {}): RecallHit[] {
    const limit = options.limit ?? 8;
    const ftsExpr = toFtsQuery(query);
    if (ftsExpr === null) return [];

    const matches = this.store.searchFts(ftsExpr, limit, options.project, options.includeGlobal);
    const hits: RecallHit[] = [];
    for (const m of matches) {
      const observation = this.store.getObservation(m.id);
      if (!observation) continue; // index drifted ahead of rows — skip defensively
      hits.push({
        observation,
        score: -m.distance,
        ftsRank: m.distance,
        global: m.project === GLOBAL_PROJECT,
      });
    }
    return hits;
  }
}
