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
}

/** The cost/usage block reported when an LLM phrased the candidates. */
export interface OptimizeEstimate {
  /** char/4 heuristic over the phrasing prompt — an *estimate*, not the billed count. */
  promptCharEstimateTokens: number;
  /** Whether an LLM phrased (false → pure heuristic spine, $0/offline). */
  llmUsed: boolean;
  /** Actual token usage reported by the backend, when present. */
  usage?: { promptTokens?: number; completionTokens?: number };
  /** `usage * pricePer1k`, when both a price and usage are available. */
  costEstimate?: number;
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
}
