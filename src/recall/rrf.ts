/**
 * Reciprocal Rank Fusion (RRF) — fuses several ranked id lists into one.
 *
 * For each list, an id at 1-based rank r contributes `1 / (k + r)` to its score;
 * scores sum across lists. Higher total = better. This is the real fusion the
 * recall layer uses to combine vector KNN and FTS results — never agentmemory's
 * positional fallback that returned identical scores regardless of the query.
 *
 * `k` (default 60) damps the weight of top ranks so a strong hit in one list does
 * not completely dominate a consistent presence across both.
 */
export const DEFAULT_RRF_K = 60;

export interface FusedHit {
  id: number;
  score: number;
  /** 1-based rank in each contributing list, when present. */
  ranks: Record<string, number>;
}

/** A named, pre-ordered list of ids (best first). */
export interface RankedList {
  name: string;
  ids: number[];
}

export function reciprocalRankFusion(lists: RankedList[], k: number = DEFAULT_RRF_K): FusedHit[] {
  const acc = new Map<number, FusedHit>();
  for (const list of lists) {
    for (let i = 0; i < list.ids.length; i++) {
      const id = list.ids[i];
      if (id === undefined) continue;
      const rank = i + 1;
      const entry = acc.get(id) ?? { id, score: 0, ranks: {} };
      entry.score += 1 / (k + rank);
      entry.ranks[list.name] = rank;
      acc.set(id, entry);
    }
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}
