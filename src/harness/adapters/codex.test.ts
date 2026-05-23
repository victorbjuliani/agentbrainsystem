// src/harness/adapters/codex.test.ts
import { describe, expect, it } from 'vitest';
import { codexAdapter } from './codex.js';

describe('codexAdapter', () => {
  it('qualifies for full parity', () => {
    expect(codexAdapter().qualifies()).toEqual({ ok: true, missing: [] });
  });

  it('maps Codex native events to canonical moments (Stop = capture, no SessionEnd)', () => {
    const { eventMap } = codexAdapter();
    expect(eventMap.capture).toContain('Stop');
    expect(eventMap.capture).not.toContain('SessionEnd');
    expect(eventMap.recall).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit']));
    expect(eventMap.guard).toContain('PreToolUse');
  });

  it('resolves the session id from the payload only — NO env var fallback', () => {
    const a = codexAdapter();
    expect(a.resolveSession({ payload: { sessionId: 'p1', transcriptPath: '/t.jsonl' } })).toEqual({
      sessionId: 'p1',
      transcriptPath: '/t.jsonl',
    });
    // A CLAUDE_CODE_SESSION_ID-style env must NOT leak into Codex resolution.
    expect(a.resolveSession({ env: { CLAUDE_CODE_SESSION_ID: 'e1' } })).toBeNull();
  });

  it('exposes mcpBinary = codex (drives mcp register/unregister)', () => {
    expect(codexAdapter().mcpBinary).toBe('codex');
  });

  it('registerMcp drives the codex binary (reports already when listed)', async () => {
    const seen: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      seen.push(cmd);
      if (args.includes('--version')) return { code: 0, stdout: 'codex', stderr: '' };
      return { code: 0, stdout: 'agentbrainsystem', stderr: '' };
    };
    expect((await codexAdapter().registerMcp('/cli.js', run)).status).toBe('already');
    expect(seen.every((c) => c === 'codex')).toBe(true);
  });
});
