// src/harness/adapters/copilot.test.ts
import { describe, expect, it } from 'vitest';
import { copilotAdapter } from './copilot.js';

describe('copilotAdapter (#69)', () => {
  it('exposes id/displayName/mcpBinary', () => {
    const a = copilotAdapter();
    expect(a.id).toBe('copilot');
    expect(a.displayName).toBe('GitHub Copilot CLI');
    expect(a.mcpBinary).toBe('copilot');
  });

  it('qualifies for full parity', () => {
    expect(copilotAdapter().qualifies()).toEqual({ ok: true, missing: [] });
  });

  it('maps Copilot native events to canonical moments (sessionEnd = capture)', () => {
    const { eventMap } = copilotAdapter();
    expect(eventMap.capture).toContain('SessionEnd');
    expect(eventMap.recall).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit']));
    expect(eventMap.guard).toContain('PreToolUse');
  });

  it('resolves the session id from the payload only — NO env var fallback', () => {
    const a = copilotAdapter();
    expect(a.resolveSession({ payload: { sessionId: 'p1', transcriptPath: '/t.jsonl' } })).toEqual({
      sessionId: 'p1',
      transcriptPath: '/t.jsonl',
    });
    // No COPILOT_* session-id env var exists; a Claude-style env must NOT leak in.
    expect(a.resolveSession({ env: { CLAUDE_CODE_SESSION_ID: 'e1' } })).toBeNull();
  });

  it('registerMcp drives the copilot binary with the separator (`--`) arg style', async () => {
    const seen: { cmd: string; args: string[] }[] = [];
    const run = async (cmd: string, args: string[]) => {
      seen.push({ cmd, args });
      if (args.includes('--version')) return { code: 0, stdout: 'copilot 1.0.51', stderr: '' };
      // not yet listed → add path; capture the add args.
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = await copilotAdapter().registerMcp('/cli.js', run);
    expect(result.status).toBe('registered');
    expect(seen.every((s) => s.cmd === 'copilot')).toBe(true);
    const add = seen.find((s) => s.args[0] === 'mcp' && s.args[1] === 'add');
    // separator style: `copilot mcp add agentbrainsystem -- node /cli.js start`
    expect(add?.args).toContain('--');
    expect(add?.args).toEqual(['mcp', 'add', 'agentbrainsystem', '--', 'node', '/cli.js', 'start']);
  });

  it('surfaces the manual command in separator shape when the binary is absent', async () => {
    const run = async () => ({ code: null, stdout: '', stderr: 'ENOENT' });
    const result = await copilotAdapter().registerMcp('/cli.js', run);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.manualCommand).toBe('copilot mcp add agentbrainsystem -- node /cli.js start');
    }
  });
});
