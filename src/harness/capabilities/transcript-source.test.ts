// src/harness/capabilities/transcript-source.test.ts
import { describe, expect, it, vi } from 'vitest';
import { jsonlTranscriptSource } from './transcript-source.js';

describe('jsonlTranscriptSource', () => {
  it('ingests a single transcript via the injected ingester', async () => {
    const ingest = vi.fn(async () => ({
      filesProcessed: 1,
      filesSkipped: 0,
      observationsAdded: 3,
      observationsSkipped: 0,
      anchorsSeeded: 1,
    }));
    const source = jsonlTranscriptSource({ ingestSingle: ingest });
    const result = await source.ingest({} as never, '/abs/transcript.jsonl');
    expect(ingest).toHaveBeenCalledWith({}, '/abs/transcript.jsonl');
    expect(result.observationsAdded).toBe(3);
  });
});
