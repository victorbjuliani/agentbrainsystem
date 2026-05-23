// src/harness/adapters/gemini.test.ts
import { describe, expect, it } from 'vitest';
import { geminiAdapter } from './gemini.js';

describe('geminiAdapter (#68)', () => {
  it('qualifies for full parity', () => {
    expect(geminiAdapter().qualifies()).toEqual({ ok: true, missing: [] });
  });

  it('maps Gemini native events to canonical moments (SessionEnd = capture)', () => {
    const { eventMap } = geminiAdapter();
    expect(eventMap.capture).toContain('SessionEnd');
    expect(eventMap.recall).toEqual(expect.arrayContaining(['SessionStart', 'BeforeAgent']));
    expect(eventMap.guard).toContain('BeforeTool');
  });

  it('resolves the session id from the payload only — NO env var fallback', () => {
    const a = geminiAdapter();
    expect(
      a.resolveSession({ payload: { sessionId: 'p1', transcriptPath: '/t.json' } }),
    ).toEqual({ sessionId: 'p1', transcriptPath: '/t.json' });
    // No GEMINI_* session-id env var exists; a Claude-style env must NOT leak in.
    expect(a.resolveSession({ env: { CLAUDE_CODE_SESSION_ID: 'e1' } })).toBeNull();
  });

  it('exposes mcpBinary = gemini', () => {
    expect(geminiAdapter().mcpBinary).toBe('gemini');
  });

  it('registerMcp drives the gemini binary with positional args (already when listed)', async () => {
    const seen: { cmd: string; args: string[] }[] = [];
    const run = async (cmd: string, args: string[]) => {
      seen.push({ cmd, args });
      if (args.includes('--version')) return { code: 0, stdout: 'gemini 0.35.0', stderr: '' };
      return { code: 0, stdout: 'agentbrainsystem', stderr: '' };
    };
    expect((await geminiAdapter().registerMcp('/cli.js', run)).status).toBe('already');
    expect(seen.every((s) => s.cmd === 'gemini')).toBe(true);
  });
});
