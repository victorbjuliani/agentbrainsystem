/**
 * Public types for ingestion (issue #7).
 *
 * Ingestion reads agent-harness transcripts and turns the human-readable text
 * of each entry into a store observation, grouping by harness session. The MVP
 * targets **Claude Code** JSONL transcripts under `~/.claude/projects/**`.
 */

/** Options accepted by `ingestClaudeProjects` / `surveyClaudeProjects`. */
export interface IngestOptions {
  /**
   * Override for the Claude projects root (defaults to `~/.claude/projects`).
   * Exposed mainly so tests can point at a temp tree without touching $HOME.
   */
  projectsDir?: string;
  /**
   * Restrict the walk to these project slugs (a transcript file's parent-dir name).
   * Undefined = every project. Lets `abs ingest --project <slug>` pull only the
   * chosen projects from the on-disk history (#62).
   */
  projects?: string[];
}

/** Per-run ingestion tally. */
export interface IngestResult {
  /** Files that had at least one new line read this run. */
  filesProcessed: number;
  /** Files skipped because their cursor already covered every line. */
  filesSkipped: number;
  /** Observations created and indexed this run. */
  observationsAdded: number;
  /** Lines read but skipped (malformed, empty, or no extractable text). */
  observationsSkipped: number;
  /** Claimed fact anchors seeded from Edit/Write tool calls this run (#25). */
  anchorsSeeded: number;
  /**
   * The store id of the last session this run resolved (#138/W2). `ingestSingleSession`
   * is scoped to one transcript = one session, so the SessionEnd cadence-due gate reads
   * this to scope a per-session obs count. `null`/undefined for a missing-file no-op or a
   * `skip`-bound session (nothing written). Defensively the LAST non-null resolved id, so
   * a rare multi-session transcript undercounts only the cadence size — never strands data.
   */
  sessionId?: number | null;
}
