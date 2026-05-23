// src/harness/capabilities/transcript-source.ts
import { ingestSingleSession } from '../../ingest/ingest.js';
import type { IngestResult } from '../../ingest/types.js';
import type { Memory } from '../../memory.js';

export interface TranscriptSource {
  ingest(memory: Memory, transcriptPath: string): Promise<IngestResult>;
}

export interface JsonlSourceOptions {
  /** Injection seam for tests; defaults to the real single-session ingester. */
  ingestSingle?: (memory: Memory, transcriptPath: string) => Promise<IngestResult>;
}

/** A JSONL-transcript source — the shape Claude Code, Codex and Copilot all use. */
export function jsonlTranscriptSource(options: JsonlSourceOptions = {}): TranscriptSource {
  const ingest = options.ingestSingle ?? ingestSingleSession;
  return { ingest: (memory, transcriptPath) => ingest(memory, transcriptPath) };
}
