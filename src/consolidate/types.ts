/**
 * Consolidation types (issue #12).
 *
 * Consolidation distills a session's raw transcript into a small set of durable
 * lessons/decisions via an LLM, then writes them back as first-class observations
 * (through the indexer, so they are recallable). These shapes are the contract
 * between the pure distill layer, the I/O orchestrator, and the CLI.
 */
import type { LlmUsage } from '../llm/index.js';

/** A single distilled insight the LLM proposes. `kind` lands on the observation row. */
export interface LessonCandidate {
  kind: 'lesson' | 'decision';
  content: string;
}

/** Caller-facing options for a consolidation run. */
export interface ConsolidateOptions {
  /** Target session id; when omitted the newest un-consolidated session is chosen. */
  sessionId?: number;
  /** Make the LLM call but write nothing — preview the candidates + cost. */
  dryRun?: boolean;
  /** Re-consolidate: delete the prior consolidation output for this session first. */
  force?: boolean;
  /** Unit price per 1k tokens for the cost-estimate line (from `config.llm.pricePer1k`). */
  pricePer1k?: number;
}

/** Why a run produced no writes without being an error (caller exits 0). */
export type ConsolidateSkip =
  | 'already-consolidated'
  | 'no-observations'
  | 'no-unconsolidated-session';

/** The cost/usage block reported alongside a run. */
export interface ConsolidateEstimate {
  /** char/4 heuristic over the prompt — explicitly an *estimate*, not the billed count. */
  promptCharEstimateTokens: number;
  /** Actual token usage as reported by the backend, when present. */
  usage?: LlmUsage;
  /** `usage * pricePer1k`, when both a price and usage are available. */
  costEstimate?: number;
}

/** The full outcome of `consolidate()`. */
export interface ConsolidateResult {
  /** Resolved target session id (0 when no session could be resolved). */
  sessionId: number;
  /** Number of lessons written (0 on dry-run / skip). */
  written: number;
  /** True when this was a preview run. */
  dryRun: boolean;
  /** The distilled candidates (empty on skip). */
  candidates: LessonCandidate[];
  /** Token estimate + actual usage + cost. */
  estimate: ConsolidateEstimate;
  /** Set when the run was a no-op for a benign reason. */
  skipped?: ConsolidateSkip;
}
