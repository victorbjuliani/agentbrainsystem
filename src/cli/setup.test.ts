import { describe, expect, it } from 'vitest';
import {
  buildClaudeMcpAddArgs,
  MCP_SERVER_NAME,
  manualMcpCommand,
  type RunFn,
  type RunResult,
  registerMcpServer,
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
