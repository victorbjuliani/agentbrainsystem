/**
 * Optimize types (issues #18, #20).
 *
 * The optimize engine turns the durable lessons/decisions that consolidation
 * (#12) wrote into the store into **evidence-backed candidate diffs** — proposed
 * edits to a project's `CLAUDE.md` or to Claude Code auto-memory — and a gated
 * applier (#20) applies a single approved candidate at a time with full
 * backup/atomic-write/rollback safety.
 *
 * These shapes are the contract between the pure candidate-generation core, the
 * optional LLM-phrasing pass, the appliers, and the #21 converge step (which wires
 * the engine into the CLI/MCP). Diffs-only: generation NEVER mutates a file.
 */
import type { LlmProvider, LlmUsage } from '../llm/index.js';

/** The two — and ONLY two — kinds of file the optimize engine may ever target. */
export type OptimizeTargetKind = 'claude-md' | 'auto-memory';

/**
 * A resolved write target. The applier's allowlist resolver maps a candidate's
 * descriptor to exactly one of the two permitted kinds and rejects anything else
 * (source code, AGENTS.md, arbitrary docs). `absPath` is the file the applier
 * would touch; for `auto-memory` it lives under the per-project memory dir.
 */
export interface OptimizeTarget {
  kind: OptimizeTargetKind;
  /** Absolute path to the file the candidate proposes to change. */
  absPath: string;
  /**
   * For `auto-memory`, the entry's frontmatter `metadata.type` when known
   * (`user | feedback | project | reference`). Drives the fail-closed guard:
   * `user` / `feedback` entries are REFUSED. Absent for `claude-md`.
   */
  memoryType?: AutoMemoryType;
}

/** Frontmatter `metadata.type` values an auto-memory markdown entry can carry. */
export type AutoMemoryType = 'user' | 'feedback' | 'project' | 'reference';

/** Priority bucket for ordering candidates; `high` derives from decisions. */
export type OptimizePriority = 'high' | 'medium' | 'low';

/**
 * One evidence-backed proposed change. Produced by generation, consumed by the
 * applier. Carries the **evidence** = the ids of the source observations
 * (consolidated lessons/decisions) it derives from, so a reviewer can trace any
 * proposed edit back to the memory that justifies it.
 */
export interface OptimizeCandidate {
  /** Stable id within a generation run (e.g. `cand-1`); lets #21 reference one. */
  id: string;
  /** Where the change would land. */
  target: OptimizeTarget;
  /** A short, human-readable title for the proposed change. */
  title: string;
  /** Why this change is proposed — phrased from the evidence. */
  rationale: string;
  /** The proposed change as a unified diff against the current target content. */
  diff: string;
  /** The exact text block the change would append/insert (the diff's payload). */
  proposedText: string;
  /**
   * How the applier turns `proposedText` into the file's next content (#140):
   *   - `append`  → `current + proposedText` (the original behavior; CLAUDE.md and a
   *     re-run on an auto-memory entry that ALREADY has frontmatter).
   *   - `replace` → write `proposedText` verbatim as the WHOLE file. Used for an
   *     auto-memory entry that needs frontmatter at the FRONT (a new file, or the
   *     one-time heal of a legacy frontmatter-less dead-drop). The previewed diff is
   *     `current → proposedText`, so the written bytes equal exactly what was reviewed.
   * Optional for back-compat; treated as `append` when absent.
   */
  contentOp?: 'append' | 'replace';
  /**
   * For an `auto-memory` candidate, the paired edit that makes the entry index-visible
   * (#140): a one-line pointer in the project's `MEMORY.md`. The native Claude Code memory
   * loads `MEMORY.md` as its index, so an entry with no pointer is a dead drop. Applied
   * AFTER the entry commits and ADDITIVE-ONLY (never rewrites user-authored index lines);
   * the applier recomputes it against a fresh `MEMORY.md` read at apply time. Absent when
   * the pointer already exists (idempotent) or for `claude-md`.
   */
  indexWrite?: IndexWrite;
  /**
   * The exact target content the diff was generated against (read read-only at
   * generation time). The applier is handed this as `expectedBaseContent` so a
   * stale candidate cannot clobber a file edited since generation (#20 TOCTOU
   * guard). INTERNAL: never serialized over MCP — the full candidate stays
   * server-side in the optimize cache.
   */
  baseContent: string;
  /** Observation ids this candidate derives from (the consolidated lessons). */
  evidenceIds: number[];
  /** Ordering hint; `high` first. */
  priority: OptimizePriority;
}

/**
 * The `MEMORY.md` index-pointer edit paired with an auto-memory entry (#140). The
 * applier recomputes the additive pointer against a FRESH read of `MEMORY.md` at apply
 * time, so `proposedText` here is the generation-time preview content (drives `diff`);
 * an intervening user edit cannot be clobbered. Only `diff` is ever serialized over
 * MCP/CLI — `proposedText`/`absPath` stay server-side like {@link OptimizeCandidate.baseContent}.
 */
export interface IndexWrite {
  /** Absolute path to the project's `MEMORY.md` (validated against the canonical path). */
  absPath: string;
  /** Generation-time full index content (preview only; recomputed at apply). */
  proposedText: string;
  /** Unified diff of the pointer addition, for review on both preview surfaces. */
  diff: string;
}

/**
 * Curation gate (#146): the verdict for one consolidated observation. `durable`
 * items are promoted; `trivia` items are dropped from the candidate set (but stay
 * in the store, still recallable). The heuristic spine is a high-precision trivia
 * detector — recall-biased toward `durable` (when uncertain, keep) — because for
 * the always-loaded `CLAUDE.md` a stray trivia bullet rots the file while a
 * false-drop is recoverable (the obs remains in the store).
 */
export type CurationVerdict = 'durable' | 'trivia';

/** One observation's heuristic curation outcome (debug/log only; not persisted). */
export interface CurationResult {
  verdict: CurationVerdict;
  /** Human-readable explanation (for logging/debugging). */
  reason: string;
  /** Heuristic rule ids that fired, e.g. `['install-oneoff']`. Empty when durable. */
  signals: string[];
}

/**
 * Curation gate cost/usage carrier (#146). Internal to the engine: it holds the
 * judge's `usage`/`costEstimate` so `optimize()` can fold them into the top-level
 * {@link OptimizeEstimate} `usage`/`costEstimate`. The PUBLIC view exposed on
 * `OptimizeEstimate.curation` is the TRIMMED `{ keptCount, droppedCount, judgeUsed }`
 * — usage/cost live at the top level, never duplicated here.
 */
export interface CurationEstimate {
  /** Observations surviving BOTH filters, over the flat consolidated set (store-wide). */
  keptCount: number;
  /** `total - keptCount` — heuristic drops + judge drops combined. */
  droppedCount: number;
  /** Did the LLM-judge actually run AND return (false: no LLM / heuristicOnly / fail-open). */
  judgeUsed: boolean;
  /** char/4 estimate of the judge prompt, when the judge ran. */
  promptCharEstimateTokens?: number;
  /** Judge token usage, when reported by the backend. */
  usage?: LlmUsage;
  /** Judge cost = (prompt+completion)/1000 * pricePer1k, when both present. */
  costEstimate?: number;
}

/** Caller-facing options for a candidate-generation run. */
export interface GenerateCandidatesOptions {
  /**
   * Project root whose `CLAUDE.md` is the target descriptor. Defaults to
   * `process.cwd()`. The auto-memory dir is derived from this path's slug.
   */
  projectRoot?: string;
  /**
   * Override the Claude Code projects root (defaults to `~/.claude/projects`).
   * Tests point this at a temp dir so generation never reads the real home.
   */
  projectsDir?: string;
  /** Cap on candidates returned (highest-priority first). Default 20. */
  limit?: number;
  /**
   * Unit price per 1k tokens for the LLM-phrasing cost line, when an LLM phrases.
   * Mirrors `config.llm.pricePer1k`.
   */
  pricePer1k?: number;
  /**
   * Optional LLM for the curation judge pass (#146). When present (and not
   * `heuristicOnly`), the judge runs as a strictly-subtractive second filter over
   * the heuristic survivors. When absent, curation is heuristic-only ($0/offline).
   */
  llm?: LlmProvider;
  /**
   * Force heuristic-only curation even when an LLM is available (#146). Default
   * false. Used by deterministic tests and as an explicit opt-out.
   */
  heuristicOnly?: boolean;
}

/** The cost/usage block reported when an LLM phrased the candidates. */
export interface OptimizeEstimate {
  /** char/4 heuristic over the phrasing prompt — an *estimate*, not the billed count. */
  promptCharEstimateTokens: number;
  /** Whether an LLM was used (phrasing OR the #146 curation judge) — false → $0/offline. */
  llmUsed: boolean;
  /** Actual token usage reported by the backend, when present (judge + phrasing summed). */
  usage?: { promptTokens?: number; completionTokens?: number };
  /** `usage * pricePer1k`, when both a price and usage are available (judge + phrasing). */
  costEstimate?: number;
  /**
   * Curation gate summary (#146): trimmed public view — counts + whether the judge
   * ran. The judge's own usage/cost fold into the top-level `usage`/`costEstimate`,
   * never duplicated here. Present on any run that went through generation.
   */
  curation?: { keptCount: number; droppedCount: number; judgeUsed: boolean };
}

/** The full outcome of a candidate-generation run. */
export interface GenerateCandidatesResult {
  /** Prioritized candidates (highest priority first). Empty when nothing to propose. */
  candidates: OptimizeCandidate[];
  /** Cost/usage of the optional LLM-phrasing pass. */
  estimate: OptimizeEstimate;
}

/** Why an apply attempt was refused or skipped without being a write failure. */
export type ApplyRefusal =
  | 'forbidden-target' // descriptor resolved outside the two-kind allowlist
  | 'forbidden-index-target' // indexWrite.absPath is not the canonical MEMORY.md (#140)
  | 'protected-memory-type' // auto-memory entry whose metadata.type is user|feedback
  | 'target-modified' // target content changed since the diff was generated
  | 'symlink-target'; // the resolved target is a symlink (lexical resolution would follow it)

/** The outcome of applying a single approved candidate. */
export interface ApplyResult {
  /** True when the file was backed up, written, and the temp atomically renamed in. */
  applied: boolean;
  /** Absolute path that was (or would have been) written. */
  absPath: string;
  /** Absolute path of the backup taken before writing (present only when applied). */
  backupPath?: string;
  /** Set when the apply was refused for a benign/guard reason (no write happened). */
  refused?: ApplyRefusal;
  /**
   * Set when the entry was written but the paired `MEMORY.md` pointer could not be
   * (#140). The entry is committed and recallable; it is simply not yet index-visible —
   * exactly the pre-#140 state — so this is a warning, NOT a failure (`applied` stays
   * true). Re-running apply re-attempts the additive pointer.
   */
  indexWarning?: string;
}
