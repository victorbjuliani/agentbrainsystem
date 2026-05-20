/**
 * Wire types for the portable export artifact (issue #8).
 *
 * The artifact is a line-delimited JSON (JSONL) file so a large store never
 * materializes as one giant string (8 GB footprint discipline, ADR 0001).
 *   - line 1   = {@link ExportHeader}
 *   - then     = one {@link SessionLine} per session
 *   - then     = one {@link ObservationLine} per observation
 *
 * Versioned via the header so future readers can detect/refuse incompatible
 * shapes. `vector` is shipped inline so an imported store recalls identically
 * without re-embedding.
 */

/** Stable artifact marker — readers reject anything that does not match. */
export const EXPORT_FORMAT = 'abs-export';

/** Current artifact schema version. Bump on any breaking line-shape change. */
export const EXPORT_VERSION = 1;

/** First line of the artifact: identifies format, version and embedding shape. */
export interface ExportHeader {
  format: typeof EXPORT_FORMAT;
  version: number;
  /** ISO timestamp the artifact was produced. */
  createdAt: string;
  /** Embedding config the vectors were produced with — `dimensions` must match the target. */
  embedding: {
    provider: string;
    model: string;
    dimensions: number;
  };
  /** Row counts at export time (informational; import recomputes its own). */
  counts: {
    sessions: number;
    observations: number;
  };
}

/** A session line. `t` discriminates the line type. */
export interface SessionLine {
  t: 'session';
  externalId: string;
  project?: string;
  startedAt?: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

/** An observation line, including its stored embedding (or null if none). */
export interface ObservationLine {
  t: 'obs';
  /** External id of the owning session — resolved to a local id on import. */
  sessionExternalId: string;
  kind: string;
  content: string;
  metadata?: Record<string, unknown>;
  source?: string;
  createdAt: string;
  /** The stored embedding, or null if the observation had no vector. */
  vector: number[] | null;
}

/** Any non-header line. */
export type ArtifactLine = SessionLine | ObservationLine;

/** Import behaviour: wipe-then-insert, or keep-and-append. */
export type ImportMode = 'replace' | 'merge';

export interface ExportResult {
  sessions: number;
  observations: number;
}

export interface ImportResult {
  sessionsImported: number;
  observationsImported: number;
}
