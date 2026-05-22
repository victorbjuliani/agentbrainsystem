import { describe, expect, it, vi } from 'vitest';
import { handleSessionEnd } from './session-end.js';

describe('handleSessionEnd — auto-ingest, $0, no injection', () => {
  it('ingests ONLY the current session transcript and returns undefined (#62)', async () => {
    const ingest = vi.fn(async (_path: string) => {});
    const result = await handleSessionEnd(
      { sessionId: 's1', transcriptPath: '/p/-Users-me/s1.jsonl' },
      { ingest },
    );
    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledWith('/p/-Users-me/s1.jsonl');
    expect(result).toBeUndefined();
  });

  it('is a no-op (never a full-tree scan) when the payload has no transcript_path (#62)', async () => {
    const ingest = vi.fn(async (_path: string) => {});
    const result = await handleSessionEnd({ sessionId: 's1' }, { ingest });
    expect(ingest).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('propagates an ingest failure to the caller (runner swallows it)', async () => {
    const ingest = vi.fn(async (_path: string) => {
      throw new Error('ingest exploded');
    });
    await expect(handleSessionEnd({ transcriptPath: '/p/x/s.jsonl' }, { ingest })).rejects.toThrow(
      'ingest exploded',
    );
  });
});
