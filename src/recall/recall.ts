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
import { kindWeight } from './kind-weight.js';
import { cosineFromL2Distance, noiseFloorConfig, passesNoiseFloor } from './noise-floor.js';
import { DEFAULT_RRF_K, reciprocalRankFusion } from './rrf.js';
import { stemVariants } from './stemming.js';

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
  /**
   * Rank curated/durable kinds (`decision`/`lesson`/`note`) above raw turns (#143) — the
   * hybrid-path twin of `recallFts({rankByKind})` (#141). The WHOLE fused pool is re-ordered
   * by `fusedScore × kindWeight(kind)`, NOT a truncated window, so a durable hit deep in the
   * pool that should win is never dropped. It is ORDERING-ONLY: each hit's `score` stays the
   * raw fused RRF value (the contract serialized to MCP clients is unchanged — the weight is
   * not exposed over the wire). A no-op `false` (default) keeps the pure fused order, so the
   * UI and any other caller are byte-identical. NOT a hard filter — when no durable kind is
   * in the pool every weight is 1 and the order collapses to pure fused.
   */
  rankByKind?: boolean;
  /**
   * Apply the recall noise floor (#144): drop hits that clear neither the query-token
   * coverage threshold NOR (using the vector leg's cosine) the semantic threshold, so a
   * query with no genuinely relevant memory returns []. Coverage OR cosine — a paraphrase
   * with low literal overlap but a strong semantic match still passes. Default `false`.
   */
  noiseFloor?: boolean;
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
  /**
   * Rank curated/durable kinds (`decision`/`lesson`/`note`) above raw turns (#141).
   * Default `false` keeps the legacy pure-FTS order and `score = -distance` contract — so
   * non-recall callers (e.g. delete-by-search) are unaffected. When `true`, over-fetch a
   * candidate pool and re-rank by `1/(RRF_K+pos) × kindWeight(kind)`; `score` becomes the
   * weighted value. Opt in only on the always-on recall-injection hooks.
   */
  rankByKind?: boolean;
  /**
   * Apply the recall noise floor (#144): drop hits that don't clear the query-token
   * coverage threshold so a prompt with no genuinely relevant memory injects NOTHING
   * instead of best-of-the-junk. FTS-only, so coverage is the signal (no cosine here).
   * Default `false` so delete-by-search still finds every lexical match. Pairs with the
   * candidate (`rankByKind`) path — the injection hooks set both; see {@link noiseFloorConfig}.
   */
  noiseFloor?: boolean;
}

/**
 * Turn free text into a safe FTS5 MATCH expression: word tokens OR-ed together,
 * each quoted so punctuation/operators in the query can't break the parser or
 * inject FTS syntax. Returns null when there is nothing searchable.
 *
 * Two opt-ins, both used only by the UI's forgiving search — recall's per-prompt
 * FTS leg passes neither, so it keeps its exact, validated semantics (#129):
 *   - `{ prefix: true }`  → each term becomes a prefix match (`"migrat"*`).
 *   - `{ stem: true }`    → each token expands to its stems across en/pt/es so a
 *     query reaches its whole word family in the bilingual store (English is the
 *     default; pt/es are extra coverage). Pairs with `prefix` for the widest reach.
 */
export function toFtsQuery(
  text: string,
  opts: { prefix?: boolean; stem?: boolean } = {},
): string | null {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of tokens) {
    if (t.length < 2) continue;
    // Stemming expands one token into its word-family roots (en/pt/es); without it
    // the term is just the token. Each distinct term is then quoted (and, when
    // `prefix`, suffixed with `*` for FTS5 prefix matching). Dedup is term-wide so
    // overlapping stems across tokens collapse.
    const variants = opts.stem ? stemVariants(t) : [t];
    for (const v of variants) {
      if (v.length < 2 || seen.has(v)) continue;
      seen.add(v);
      terms.push(opts.prefix ? `"${v}"*` : `"${v}"`);
    }
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

    const { project, includeGlobal, rankByKind, noiseFloor } = options;
    const [queryVector] = await this.provider.embed([query]);
    const vectorHits = queryVector
      ? this.store.knn(queryVector, candidates, project, includeGlobal)
      : [];
    const vectorIds = vectorHits.map((h) => h.id);
    // Per-id cosine (unit vectors: cos = 1 − L2²/2) so the noise floor can pass a strong
    // SEMANTIC match even when its literal token coverage is low (a paraphrase).
    const cosineById = new Map<number, number>();
    if (noiseFloor) {
      for (const h of vectorHits) cosineById.set(h.id, cosineFromL2Distance(h.distance));
    }

    const ftsExpr = toFtsQuery(query);
    // Keep the full FTS matches (not just ids) so kind-weighting gets `kind` for the FTS
    // leg for FREE (searchFts already joins it); only vector-only candidates need a lookup.
    const ftsMatches = ftsExpr
      ? this.store.searchFts(ftsExpr, candidates, project, includeGlobal)
      : [];

    const fused = reciprocalRankFusion(
      [
        { name: 'vector', ids: vectorIds },
        { name: 'fts', ids: ftsMatches.map((m) => m.id) },
      ],
      rrfK,
    );

    const ordered = rankByKind ? this.orderFusedByKind(fused, ftsMatches) : fused;

    const floorCfg = noiseFloor ? noiseFloorConfig() : undefined;
    const hits: RecallHit[] = [];
    for (const f of ordered) {
      if (hits.length >= limit) break;
      const observation = this.store.getObservation(f.id);
      if (!observation) continue; // index drifted ahead of rows — skip defensively
      // #144: drop a hit that clears neither lexical coverage nor (via the vector leg)
      // the semantic cosine — so a query with no relevant memory returns []. Skipping a
      // junk candidate lets a real one further down the pool take the slot instead.
      if (
        floorCfg &&
        !passesNoiseFloor(query, observation.content, cosineById.get(f.id), floorCfg)
      ) {
        continue;
      }
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
   * Re-order the WHOLE fused pool by `fusedScore × kindWeight(kind)` so durable kinds lead
   * (#143). Re-ranking the entire pool (not a truncated top-N) means a durable hit deep in
   * the pool that should win after weighting is never excluded; only the final `≤limit`
   * `getObservation` calls cost I/O, so this stays bounded. `kind` comes from the FTS leg
   * for free; vector-only candidates are resolved in ONE batched `kindsByIds` query. The
   * returned items keep their fused `score` — the weight drives ORDER only.
   */
  private orderFusedByKind(
    fused: ReturnType<typeof reciprocalRankFusion>,
    ftsMatches: ReadonlyArray<{ id: number; kind?: string }>,
  ): ReturnType<typeof reciprocalRankFusion> {
    const kindById = new Map<number, string>();
    for (const m of ftsMatches) if (m.kind !== undefined) kindById.set(m.id, m.kind);
    const missing = fused.filter((f) => !kindById.has(f.id)).map((f) => f.id);
    if (missing.length > 0) {
      for (const [id, kind] of this.store.kindsByIds(missing)) kindById.set(id, kind);
    }
    // Stable: ties (equal weighted score) keep the original fused order via the index tiebreak.
    return fused
      .map((f, i) => ({ f, i, weighted: f.score * kindWeight(kindById.get(f.id) ?? '') }))
      .sort((a, b) => b.weighted - a.weighted || a.i - b.i)
      .map((x) => x.f);
  }

  /**
   * FTS-only recall — the fast path for the per-prompt hook (#19). Deliberately
   * does NOT call `provider.embed`, so it never pays the local model's cold-load
   * tax and can never hit the first-ever-download landmine (ADR-0005). It is the
   * lexical leg of `recall` in isolation: `toFtsQuery` → `store.searchFts`.
   *
   * `ftsRank` is the raw FTS5 rank (more negative = better); callers that want a
   * descending "best first" score can negate it. Returns at most `limit` hits.
   *
   * With `options.rankByKind` (#141) the result is re-ranked so curated/durable kinds
   * outrank raw turns, and `score` becomes the weighted value (not `-distance`) — see
   * `RecallFtsOptions.rankByKind` and {@link recallFtsRankedByKind}. Default is the
   * legacy pure-FTS order, so non-recall callers (e.g. delete-by-search) are unaffected.
   */
  recallFts(query: string, options: RecallFtsOptions = {}): RecallHit[] {
    const limit = options.limit ?? 8;
    const ftsExpr = toFtsQuery(query);
    if (ftsExpr === null) return [];

    // The candidate (over-fetch) path handles BOTH the kind re-rank (#141) and the noise
    // floor (#144) — either opt-in routes here; delete-by-search (neither) keeps the exact
    // default path below.
    if (options.rankByKind || options.noiseFloor) {
      return this.recallFtsRankedByKind(query, ftsExpr, limit, options);
    }

    // Default path — pure FTS order, `score = -distance` (unchanged contract; #141).
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

  /**
   * Kind-weighted FTS recall (#141): over-fetch a candidate pool, lift durable kinds with a
   * reciprocal-rank base × `kindWeight`, then take the top `limit`. NOT a hard filter — when
   * no durable kind matches, every weight is 1 and the order collapses to pure FTS (raw turns
   * still surface). The pool is the lexical floor: a durable obs must be in the top-N FTS
   * matches to be promoted, so it always at least matched the query terms.
   */
  private recallFtsRankedByKind(
    query: string,
    ftsExpr: string,
    limit: number,
    options: RecallFtsOptions,
  ): RecallHit[] {
    const candidates = Math.max(limit * 5, 40);
    const matches = this.store.searchFts(
      ftsExpr,
      candidates,
      options.project,
      options.includeGlobal,
    );
    // `pos` is the FTS rank position (best = 0). The kind weight applies ONLY when the
    // caller asked to rank by kind (#141); a noiseFloor-only caller keeps pure FTS order
    // (weight 1). Stable sort keeps FTS order within ties.
    const ranked = matches
      .map((m, pos) => ({
        m,
        score: (1 / (DEFAULT_RRF_K + pos)) * (options.rankByKind ? kindWeight(m.kind ?? '') : 1),
      }))
      .sort((a, b) => b.score - a.score);

    const floorCfg = options.noiseFloor ? noiseFloorConfig() : undefined;
    const hits: RecallHit[] = [];
    for (const { m, score } of ranked) {
      if (hits.length >= limit) break;
      const observation = this.store.getObservation(m.id);
      if (!observation) continue; // index drifted ahead of rows — skip defensively
      // #144: FTS leg has no cosine, so the floor is coverage-only here. Skipping a junk
      // candidate lets a real one further down the over-fetched pool fill the slot; an
      // all-junk pool yields [] ("nothing relevant"). Safe for FTS — it only ever returns
      // lexical matches, so there is no semantic paraphrase to wrongly suppress.
      if (floorCfg && !passesNoiseFloor(query, observation.content, undefined, floorCfg)) {
        continue;
      }
      hits.push({
        observation,
        score,
        ftsRank: m.distance,
        global: m.project === GLOBAL_PROJECT,
      });
    }
    return hits;
  }
}
