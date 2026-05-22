/**
 * Ingestion module public surface (issue #7).
 *
 * Reads Claude Code JSONL transcripts and feeds each readable conversation turn
 * through the index-at-write path into the memory store, incrementally.
 */

export type { ParsedEntry } from './claude-jsonl.js';
export { parseLine } from './claude-jsonl.js';
export { defaultClaudeProjectsDir, ingestClaudeProjects } from './ingest.js';
export type { BindingDecision, SessionBinding } from './session-binding.js';
export {
  clearBinding,
  readBinding,
  sanitizeProjectName,
  writeBinding,
} from './session-binding.js';
export type { IngestOptions, IngestResult } from './types.js';
