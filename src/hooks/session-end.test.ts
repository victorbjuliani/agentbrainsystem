import { describe, expect, it, vi } from 'vitest';
import { handleSessionEnd } from './session-end.js';

describe('handleSessionEnd — auto-ingest, $0, no injection', () => {
  it('triggers ingest and returns undefined (SessionEnd cannot inject)', async () => {
    const ingest = vi.fn(async () => {});
    const result = await handleSessionEnd({ sessionId: 's1' }, { ingest });
    expect(ingest).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
  });

  it('propagates an ingest failure to the caller (runner swallows it)', async () => {
    const ingest = vi.fn(async () => {
      throw new Error('ingest exploded');
    });
    await expect(handleSessionEnd({}, { ingest })).rejects.toThrow('ingest exploded');
  });
});
