// src/harness/adapters/claude-code.test.ts
import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from './claude-code.js';

describe('claudeCodeAdapter', () => {
  it('qualifies for full parity', () => {
    expect(claudeCodeAdapter().qualifies()).toEqual({ ok: true, missing: [] });
  });

  it('maps native events to canonical moments', () => {
    const { eventMap } = claudeCodeAdapter();
    expect(eventMap.capture).toContain('SessionEnd');
    expect(eventMap.recall).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit']));
    expect(eventMap.guard).toContain('PreToolUse');
  });

  it('resolves the session id from the payload first, then the env var', () => {
    const adapter = claudeCodeAdapter();
    expect(adapter.resolveSession({ payload: { sessionId: 'p1' } })?.sessionId).toBe('p1');
    expect(adapter.resolveSession({ env: { CLAUDE_CODE_SESSION_ID: 'e1' } })?.sessionId).toBe('e1');
  });

  it('registerMcp delegates to the injected run (reports already)', async () => {
    const run = async (_c: string, args: string[]) =>
      args.includes('--version')
        ? { code: 0, stdout: 'claude', stderr: '' }
        : { code: 0, stdout: 'agentbrainsystem', stderr: '' };
    expect((await claudeCodeAdapter().registerMcp('/cli.js', run)).status).toBe('already');
  });
});
