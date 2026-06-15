/**
 * Curation gate (#146) — the durability filter between consolidation (#12) and
 * promotion (#18). Consolidation distills a session into `kind:lesson|decision`
 * items; WITHOUT a quality bar, candidate-gen promotes EVERY one verbatim, so
 * operational trivia (install one-offs, action/event logs, tool-config noise)
 * rots the always-loaded `CLAUDE.md`. This module is that bar.
 *
 * Two composed filters (precedence is LOCKED):
 *   1. HEURISTIC SPINE (`scoreDurability`) — pure, $0/offline, deterministic, and
 *      the UNCONDITIONAL hard floor. It is a high-precision *trivia* detector,
 *      RECALL-BIASED toward `durable`: it returns `trivia` only when a
 *      high-confidence mechanical signal fires, otherwise `durable`. For the
 *      always-loaded `CLAUDE.md` a stray trivia bullet rots the file, but a
 *      false-drop is recoverable (the obs stays in the store, still recallable),
 *      so when uncertain we KEEP.
 *   2. LLM-JUDGE (`llm-judge.ts`, opt-in) — strictly SUBTRACTIVE and SECONDARY:
 *      it only ever sees the heuristic survivors and can only drop MORE (the
 *      semantic trivia the heuristic deliberately keeps, e.g. tool-config). It can
 *      never rescue a heuristic-dropped item.
 *
 * An observation is promoted iff it survives BOTH. Dropped items are removed from
 * the candidate set only — never from the store.
 */
import type { LlmProvider } from '../llm/index.js';
import type { Observation } from '../store/index.js';
import { judgeObservations } from './llm-judge.js';
import type { CurationEstimate, CurationResult } from './types.js';

/**
 * Install / environment one-offs — high-confidence trivia. These name a machine
 * action or a platform artifact (a `.dmg`, a quarantine xattr, an uninstall) that
 * belongs in setup docs, never in always-loaded durable project memory.
 */
const INSTALL_ONEOFF =
  /\.dmg\b|\baarch64\b|\bx86_64\b|\bcom\.apple\.quarantine\b|\bquarantine\b|\bxattr\b|\brestart(?:ing)?\s+claude\s+code\b|\buninstall(?:ed|ing|ation)?\b|\breinstall(?:ed|ing|ation)?\b|\binstaller\b/i;

/**
 * Work-completion verbs that, COMBINED with an issue/PR reference, mark an
 * action/event log ("Prioritized remediation … #968 over #955"). LOAD-BEARING: this
 * list is deliberately NARROW and excludes decision-framing verbs (chose, adopted,
 * selected, decided, standardized, implemented). Widening it to those would silently
 * drop legitimate decisions AND break the existing optimize integration seed
 * ("Chose SQLite + sqlite-vec …") — see curate.test.ts seed-survival guard.
 */
const COMPLETION_VERB =
  /\b(published|republished|deployed|redeployed|shipped|merged|prioriti[sz]ed|remediat\w*)\b/i;
/** An issue / PR reference like `#968`. */
const ISSUE_REF = /#\d+/;
/**
 * "successfully" — a completion marker. Recall-biased: it only fires action-log when it
 * CO-OCCURS with a completion verb (so "All 5 were successfully published" drops, but a
 * durable decision phrased "the migration was completed successfully" — no listed verb —
 * is KEPT). Never fires on its own.
 */
const SUCCESSFULLY = /\bsuccessfully\b/i;
/**
 * Quantified completion: "All 5 packages were …". The gap between the count and were/was is
 * bounded (≤80 non-newline chars) so a long multi-sentence observation that merely opens with
 * "All 5 X…" and contains an unrelated "was" far later is NOT swept in (recall-bias).
 */
const QUANTIFIED_COMPLETION = /\ball\s+\d+\b[^\n]{0,80}?\b(?:were|was)\b/i;

/**
 * Score one consolidated observation for promotion durability. Pure and
 * deterministic — no I/O. Returns `trivia` ONLY on a high-confidence signal;
 * everything else is `durable` (recall-biased; the LLM-judge is the semantic
 * safety net for what this deliberately keeps).
 *
 * Note: signals are intentionally English-only and mechanical. The judge covers
 * the semantic cases (e.g. tool-config that reads like a real decision).
 */
export function scoreDurability(obs: Observation): CurationResult {
  const text = obs.content;
  const signals: string[] = [];

  if (INSTALL_ONEOFF.test(text)) signals.push('install-oneoff');

  const isActionLog =
    (COMPLETION_VERB.test(text) && (ISSUE_REF.test(text) || SUCCESSFULLY.test(text))) ||
    QUANTIFIED_COMPLETION.test(text);
  if (isActionLog) signals.push('action-log');

  if (signals.length > 0) {
    return { verdict: 'trivia', reason: `matched ${signals.join(', ')}`, signals };
  }
  return { verdict: 'durable', reason: 'no trivia signal', signals: [] };
}

/**
 * Curate a FLAT list of consolidated observations (Cluster-agnostic by design — the
 * caller owns any cluster reshaping). Applies the heuristic floor, then — when an
 * LLM is provided and `heuristicOnly` is not set — a SINGLE judge round-trip over
 * the heuristic survivors. Returns the set of observation ids that survive BOTH
 * filters plus a {@link CurationEstimate} (store-wide counts + the judge's usage/cost,
 * which the caller folds into the top-level estimate).
 *
 * Counts are store-wide totals over `observations`: `keptCount = keep.size`,
 * `droppedCount = observations.length - keptCount` (heuristic drops + judge drops).
 */
export async function curateObservations(
  observations: Observation[],
  opts: {
    llm?: LlmProvider;
    heuristicOnly?: boolean;
    pricePer1k?: number;
  },
): Promise<{ keep: Set<number>; estimate: CurationEstimate }> {
  const total = observations.length;
  const heuristicKept = observations.filter((o) => scoreDurability(o).verdict === 'durable');

  let keep = new Set<number>(heuristicKept.map((o) => o.id));
  let judgeUsed = false;
  let promptCharEstimateTokens: number | undefined;
  let usage: CurationEstimate['usage'];
  let costEstimate: number | undefined;

  if (opts.llm && !opts.heuristicOnly && heuristicKept.length > 0) {
    const { keep: judgeKeep, estimate } = await judgeObservations(
      heuristicKept,
      opts.llm,
      opts.pricePer1k,
    );
    keep = new Set<number>(heuristicKept.filter((o) => judgeKeep.has(o.id)).map((o) => o.id));
    judgeUsed = estimate.judgeUsed;
    promptCharEstimateTokens = estimate.promptCharEstimateTokens;
    usage = estimate.usage;
    costEstimate = estimate.costEstimate;
  }

  const keptCount = keep.size;
  const estimate: CurationEstimate = { keptCount, droppedCount: total - keptCount, judgeUsed };
  if (promptCharEstimateTokens !== undefined)
    estimate.promptCharEstimateTokens = promptCharEstimateTokens;
  if (usage !== undefined) estimate.usage = usage;
  if (costEstimate !== undefined) estimate.costEstimate = costEstimate;
  return { keep, estimate };
}
