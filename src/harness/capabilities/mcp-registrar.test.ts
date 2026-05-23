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
});
