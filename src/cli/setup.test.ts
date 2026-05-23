import { describe, expect, it } from 'vitest';
import {
  buildClaudeMcpAddArgs,
  buildClaudeMcpRemoveArgs,
  MCP_SERVER_NAME,
  manualMcpCommand,
  manualMcpRemoveCommand,
  type RunFn,
  type RunResult,
  registerMcpServer,
  unregisterMcpServer,
} from './setup.js';

const CLI = '/abs/path/dist/cli/cli.js';
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

/** A `run` that returns scripted results keyed by the exact `cmd + args` join. */
function scriptedRun(script: Record<string, RunResult | Error>): RunFn {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    const v = script[key];
    if (v === undefined) throw new Error(`unscripted run: ${key}`);
    if (v instanceof Error) throw v;
    return v;
  };
}

describe('setup core — argv + manual command', () => {
  it('builds the claude mcp add argv as `node <cli> start`', () => {
    expect(buildClaudeMcpAddArgs(CLI)).toEqual([
      'mcp',
      'add',
      MCP_SERVER_NAME,
      '--',
      'node',
      CLI,
      'start',
    ]);
  });

  it('formats a copy-pasteable manual command', () => {
    expect(manualMcpCommand(CLI)).toBe(`claude mcp add ${MCP_SERVER_NAME} -- node ${CLI} start`);
  });
});

describe('registerMcpServer — idempotent, non-fatal', () => {
  it('returns no-claude when the claude CLI cannot be spawned', async () => {
    const run = scriptedRun({ 'claude --version': new Error('ENOENT') });
    const res = await registerMcpServer(CLI, run);
    expect(res).toEqual({ status: 'no-claude', manualCommand: manualMcpCommand(CLI) });
  });

  it('returns no-claude when `claude --version` exits non-zero', async () => {
    const run = scriptedRun({ 'claude --version': { code: 127, stdout: '', stderr: 'not found' } });
    const res = await registerMcpServer(CLI, run);
    expect(res.status).toBe('no-claude');
  });

  it('returns already when the server is present in `claude mcp list`', async () => {
    const run = scriptedRun({
      'claude --version': ok('1.2.3'),
      'claude mcp list': ok(`other: cmd\n${MCP_SERVER_NAME}: node ${CLI} start\n`),
    });
    expect((await registerMcpServer(CLI, run)).status).toBe('already');
  });

  it('registers when absent and `claude mcp add` succeeds', async () => {
    const run = scriptedRun({
      'claude --version': ok('1.2.3'),
      'claude mcp list': ok('nothing here\n'),
      [`claude ${buildClaudeMcpAddArgs(CLI).join(' ')}`]: ok(
        'Added stdio MCP server agentbrainsystem',
      ),
    });
    expect((await registerMcpServer(CLI, run)).status).toBe('registered');
  });

  it('surfaces the captured message when `claude mcp add` fails', async () => {
    const run = scriptedRun({
      'claude --version': ok('1.2.3'),
      'claude mcp list': ok(''),
      [`claude ${buildClaudeMcpAddArgs(CLI).join(' ')}`]: { code: 1, stdout: '', stderr: 'boom' },
    });
    const res = await registerMcpServer(CLI, run);
    expect(res).toEqual({
      status: 'error',
      message: 'boom',
      manualCommand: manualMcpCommand(CLI),
    });
  });

  it('still attempts the add when `claude mcp list` itself fails', async () => {
    const run = scriptedRun({
      'claude --version': ok('1.2.3'),
      'claude mcp list': new Error('list crashed'),
      [`claude ${buildClaudeMcpAddArgs(CLI).join(' ')}`]: ok(),
    });
    expect((await registerMcpServer(CLI, run)).status).toBe('registered');
  });
});

describe('registerMcpServer — generalized to any CLI binary', () => {
  it('drives a codex binary: probes "codex --version", lists, then "codex mcp add … -- node <cli> start"', async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args.includes('--version')) return { code: 0, stdout: 'codex-cli 0.125.0', stderr: '' };
      if (args.includes('list')) return { code: 0, stdout: '', stderr: '' }; // not registered yet
      return { code: 0, stdout: '', stderr: '' };
    };
    const res = await registerMcpServer('/abs/cli.js', run, { binary: 'codex' });
    expect(res.status).toBe('registered');
    expect(calls[0]).toEqual(['codex', '--version']);
    expect(calls.at(-1)).toEqual([
      'codex',
      'mcp',
      'add',
      'agentbrainsystem',
      '--',
      'node',
      '/abs/cli.js',
      'start',
    ]);
  });

  it('defaults to the claude binary when no options are passed (regression)', async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args.includes('--version')) return { code: 0, stdout: 'claude', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    await registerMcpServer('/abs/cli.js', run);
    expect(calls[0]).toEqual(['claude', '--version']);
    expect(calls.at(-1)).toEqual([
      'claude',
      'mcp',
      'add',
      'agentbrainsystem',
      '--',
      'node',
      '/abs/cli.js',
      'start',
    ]);
  });

  it('unregisterMcpServer drives the codex binary when given { binary: "codex" }', async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args.includes('--version')) return { code: 0, stdout: 'codex', stderr: '' };
      if (args.includes('list')) return { code: 0, stdout: 'agentbrainsystem: x', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const res = await unregisterMcpServer(run, { binary: 'codex' });
    expect(res.status).toBe('removed');
    expect(calls.every((c) => c[0] === 'codex')).toBe(true);
    expect(calls.at(-1)).toEqual(['codex', 'mcp', 'remove', 'agentbrainsystem']);
  });
});

describe('unregister core — argv + manual command', () => {
  it('builds the claude mcp remove argv (no cli path needed)', () => {
    expect(buildClaudeMcpRemoveArgs()).toEqual(['mcp', 'remove', MCP_SERVER_NAME]);
  });

  it('formats a copy-pasteable manual remove command', () => {
    expect(manualMcpRemoveCommand()).toBe(`claude mcp remove ${MCP_SERVER_NAME}`);
  });
});

describe('unregisterMcpServer — idempotent, non-fatal', () => {
  it('returns no-claude when the claude CLI cannot be spawned', async () => {
    const run = scriptedRun({ 'claude --version': new Error('ENOENT') });
    const res = await unregisterMcpServer(run);
    expect(res).toEqual({ status: 'no-claude', manualCommand: manualMcpRemoveCommand() });
  });

  it('returns no-claude when `claude --version` exits non-zero', async () => {
    const run = scriptedRun({ 'claude --version': { code: 127, stdout: '', stderr: '' } });
    expect((await unregisterMcpServer(run)).status).toBe('no-claude');
  });

  it('returns not-registered when the server is absent from `claude mcp list`', async () => {
    const run = scriptedRun({
      'claude --version': ok('1.2.3'),
      'claude mcp list': ok('other: cmd\n'),
    });
    expect((await unregisterMcpServer(run)).status).toBe('not-registered');
  });

  it('removes when present and `claude mcp remove` succeeds', async () => {
    const run = scriptedRun({
      'claude --version': ok('1.2.3'),
      'claude mcp list': ok(`${MCP_SERVER_NAME}: node /x start\n`),
      [`claude ${buildClaudeMcpRemoveArgs().join(' ')}`]: ok('Removed MCP server agentbrainsystem'),
    });
    expect((await unregisterMcpServer(run)).status).toBe('removed');
  });

  it('surfaces the captured message when `claude mcp remove` fails', async () => {
    const run = scriptedRun({
      'claude --version': ok('1.2.3'),
      'claude mcp list': ok(`${MCP_SERVER_NAME}: node /x start\n`),
      [`claude ${buildClaudeMcpRemoveArgs().join(' ')}`]: { code: 1, stdout: '', stderr: 'boom' },
    });
    expect(await unregisterMcpServer(run)).toEqual({
      status: 'error',
      message: 'boom',
      manualCommand: manualMcpRemoveCommand(),
    });
  });

  it('still attempts the remove when `claude mcp list` itself fails', async () => {
    const run = scriptedRun({
      'claude --version': ok('1.2.3'),
      'claude mcp list': new Error('list crashed'),
      [`claude ${buildClaudeMcpRemoveArgs().join(' ')}`]: ok(),
    });
    expect((await unregisterMcpServer(run)).status).toBe('removed');
  });
});
