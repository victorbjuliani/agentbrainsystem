// src/harness/capabilities/mcp-registrar.test.ts
import { describe, expect, it } from 'vitest';
import { cliMcpRegistrar } from './mcp-registrar.js';

describe('cliMcpRegistrar', () => {
  it('reports "already" when the server is registered', async () => {
    const run = async (_cmd: string, args: string[]) => {
      if (args.includes('--version')) return { code: 0, stdout: 'claude 1', stderr: '' };
      if (args.includes('list')) return { code: 0, stdout: 'agentbrainsystem', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const registrar = cliMcpRegistrar();
    expect(await registrar.register('/path/cli.js', run)).toEqual({ status: 'already' });
  });

  it('maps no-claude to the canonical unavailable status', async () => {
    const run = async () => ({ code: null, stdout: '', stderr: '' });
    const registrar = cliMcpRegistrar();
    expect((await registrar.register('/path/cli.js', run)).status).toBe('unavailable');
  });

  it('passes the configured binary through to registerMcpServer (codex)', async () => {
    const seen: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      seen.push(cmd);
      if (args.includes('--version')) return { code: 0, stdout: 'codex', stderr: '' };
      if (args.includes('list')) return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const registrar = cliMcpRegistrar({ binary: 'codex' });
    expect((await registrar.register('/cli.js', run)).status).toBe('registered');
    expect(seen.every((c) => c === 'codex')).toBe(true);
  });

  it('gemini registrar drives the gemini binary with positional args (no --, #68)', async () => {
    const seen: { cmd: string; args: string[] }[] = [];
    const run = async (cmd: string, args: string[]) => {
      seen.push({ cmd, args });
      return {
        code: 0,
        stdout: args.includes('--version') ? 'gemini 0.35.0' : '',
        stderr: '',
      };
    };
    const r = await cliMcpRegistrar({
      binary: 'gemini',
      argStyle: 'positional',
      scope: 'user',
    }).register('/cli.js', run);
    expect(r.status).toBe('registered');
    expect(seen.find((s) => s.args.includes('add'))?.args).not.toContain('--');
    expect(seen.find((s) => s.args.includes('add'))?.args).toContain('--scope');
    expect(seen.every((s) => s.cmd === 'gemini')).toBe(true);
  });
});
