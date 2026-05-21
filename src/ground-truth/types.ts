/**
 * GroundTruthProvider — the port the verifiable-memory layer uses to ask the
 * codebase "does this symbol/file still exist, and where?" (discovery D5).
 *
 * It is an anti-corruption boundary: the rest of abs never touches the
 * code-review-graph schema directly. A null adapter lets every consumer
 * degrade gracefully (local-first / offline / graph-absent) — resolution just
 * returns null and callers fall back to `claimed`/warn-only. Fail-open is the
 * contract: a provider NEVER throws on a lookup miss, it returns null.
 */

/** A resolved code location for a symbol or file in current ground truth. */
export interface ResolvedSymbol {
  /** Qualified name as ground truth knows it (e.g. `module.Class.method`). */
  qualifiedName: string;
  filePath: string;
  /** 1-based start line, when known. */
  line?: number;
  /** The commit ground truth was built at, when known (pins `verified` anchors). */
  commitSha?: string;
}

export interface GroundTruthProvider {
  /** True when this provider can answer lookups (graph present + readable). */
  isAvailable(): boolean;
  /**
   * Resolve a symbol by name. Pass `filePath` to disambiguate when the same
   * name exists in several files. Pass `unique: true` to require an unambiguous
   * match — when the bare name resolves to more than one location the result is
   * null (used by self-healing's move path so a deleted symbol is never
   * re-anchored onto an unrelated homonym). Returns null when not found, when
   * ambiguous under `unique`, OR when unavailable — never throws (fail-open).
   */
  resolveSymbol(
    name: string,
    opts?: { filePath?: string; unique?: boolean },
  ): ResolvedSymbol | null;
  /** Resolve a file by absolute path. Returns null when absent/unavailable. */
  resolveFile(filePath: string): ResolvedSymbol | null;
  /** Current branch of the underlying repo (FR-C1), or undefined when unknown. */
  currentBranch(): string | undefined;
  /** Release any held resources (e.g. an open SQLite handle). Safe to call twice. */
  close(): void;
}
