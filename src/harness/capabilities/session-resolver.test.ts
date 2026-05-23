// src/harness/capabilities/session-resolver.test.ts
import { describe, expect, it } from 'vitest';
import { payloadFirstResolver } from './session-resolver.js';

describe('payloadFirstResolver', () => {
  it('reads session id + transcript path from the payload', () => {
    const resolve = payloadFirstResolver();
    expect(resolve({ payload: { sessionId: 's1', transcriptPath: '/t.jsonl' } })).toEqual({
      sessionId: 's1',
      transcriptPath: '/t.jsonl',
    });
  });

  it('falls back to an env var when the payload has no id', () => {
    const resolve = payloadFirstResolver({ envVar: 'CLAUDE_CODE_SESSION_ID' });
    expect(resolve({ env: { CLAUDE_CODE_SESSION_ID: 'env-id' } })).toEqual({ sessionId: 'env-id' });
  });

  it('returns null when neither payload nor env yields an id', () => {
    const resolve = payloadFirstResolver({ envVar: 'CLAUDE_CODE_SESSION_ID' });
    expect(resolve({ env: {} })).toBeNull();
  });
});
