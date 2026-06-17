import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportStore } from '../export/index.js';
import type { LlmConfig, LlmProvider } from '../llm/types.js';
import { MemoryStore } from '../store/memory-store.js';
import {
  buildClaudeMcpAddArgs,
  buildClaudeMcpRemoveArgs,
  buildExportSnippet,
  buildMcpAddArgs,
  buildProbeConfig,
  type LlmAnswers,
  type LlmChoice,
  MCP_SERVER_NAME,
  manualMcpCommand,
  manualMcpRemoveCommand,
  PROBE_TIMEOUT_MS,
  type ProbeResult,
  probeLlm,
  type RunFn,
  type RunResult,
  registerMcpServer,
  runLlmSetupStep,
  SETUP_LAST_RUN_AT_KEY,
  SETUP_LLM_CHOICE_KEY,
  type SetupIo,
  shouldPromptForLlm,
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

  // #109 — the harness id is baked into the launch command so the server resolves
  // env-based sessions through the launching harness, not a hard-coded claude-code.
  it('appends `start --harness <id>` when a harnessId is given', () => {
    expect(buildMcpAddArgs(CLI, { harnessId: 'codex' })).toEqual([
      'mcp',
      'add',
      MCP_SERVER_NAME,
      '--',
      'node',
      CLI,
      'start',
      '--harness',
      'codex',
    ]);
    expect(manualMcpCommand(CLI, 'codex', { harnessId: 'codex' })).toBe(
      `codex mcp add ${MCP_SERVER_NAME} -- node ${CLI} start --harness codex`,
    );
  });

  it('omits the --harness suffix when no harnessId is given (legacy byte-identical)', () => {
    expect(buildMcpAddArgs(CLI)).not.toContain('--harness');
  });

  // #109 Codex review: the positional (Gemini) form needs an argv terminator before
  // the dash-leading `--harness`, or Gemini's parser eats it as a `mcp add` flag.
  it('inserts a `--` terminator before --harness in the positional (Gemini) form', () => {
    expect(
      buildMcpAddArgs(CLI, { argStyle: 'positional', scope: 'user', harnessId: 'gemini' }),
    ).toEqual([
      'mcp',
      'add',
      MCP_SERVER_NAME,
      '--scope',
      'user',
      'node',
      CLI,
      'start',
      '--',
      '--harness',
      'gemini',
    ]);
    expect(
      manualMcpCommand(CLI, 'gemini', {
        argStyle: 'positional',
        scope: 'user',
        harnessId: 'gemini',
      }),
    ).toBe(`gemini mcp add ${MCP_SERVER_NAME} --scope user node ${CLI} start -- --harness gemini`);
  });
});

describe('Gemini positional arg style (#68 — Gemini rejects the -- separator)', () => {
  it('builds positional Gemini add args without the -- separator', () => {
    expect(buildMcpAddArgs(CLI, { argStyle: 'positional', scope: 'user' })).toEqual([
      'mcp',
      'add',
      MCP_SERVER_NAME,
      '--scope',
      'user',
      'node',
      CLI,
      'start',
    ]);
  });
  it('default add args keep the -- separator (claude/codex unchanged)', () => {
    expect(buildMcpAddArgs(CLI)).toEqual([
      'mcp',
      'add',
      MCP_SERVER_NAME,
      '--',
      'node',
      CLI,
      'start',
    ]);
  });
  it('manual command for Gemini is POSITIONAL — no -- separator', () => {
    expect(manualMcpCommand('/cli.js', 'gemini', { argStyle: 'positional', scope: 'user' })).toBe(
      'gemini mcp add agentbrainsystem --scope user node /cli.js start',
    );
  });
  it('manual command default keeps the -- form (claude/codex byte-identical)', () => {
    expect(manualMcpCommand('/cli.js')).toBe(
      'claude mcp add agentbrainsystem -- node /cli.js start',
    );
    expect(manualMcpCommand('/cli.js', 'codex')).toBe(
      'codex mcp add agentbrainsystem -- node /cli.js start',
    );
  });
  it('W3: on a failed gemini mcp add (e.g. unauthed), the surfaced manual command is positional', async () => {
    const run = async (_cmd: string, args: string[]): Promise<RunResult> =>
      args.includes('--version')
        ? { code: 0, stdout: 'gemini 0.35.0', stderr: '' }
        : args.includes('list')
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 1, stdout: '', stderr: 'authentication required' };
    const r = await registerMcpServer('/cli.js', run, {
      binary: 'gemini',
      argStyle: 'positional',
      scope: 'user',
    });
    expect(r.status).toBe('error');
    if (r.status === 'error')
      expect(r.manualCommand).toBe(
        'gemini mcp add agentbrainsystem --scope user node /cli.js start',
      );
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

  it('unregisterMcpServer removes the user-scoped Gemini server with --scope user (#87)', async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args.includes('--version')) return { code: 0, stdout: 'gemini', stderr: '' };
      if (args.includes('list')) return { code: 0, stdout: 'agentbrainsystem: x', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const res = await unregisterMcpServer(run, {
      binary: 'gemini',
      argStyle: 'positional',
      scope: 'user',
    });
    expect(res.status).toBe('removed');
    // Without the scope the user-scoped server is left behind (project-scope default).
    expect(calls.at(-1)).toEqual([
      'gemini',
      'mcp',
      'remove',
      'agentbrainsystem',
      '--scope',
      'user',
    ]);
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

// ----------------------------------------------------------- LLM setup step

describe('shouldPromptForLlm — pure decision (truth table)', () => {
  it('TTY + unset choice → prompt', () => {
    expect(shouldPromptForLlm(null, true, false)).toBe(true);
  });
  it('TTY + declined → re-offer (they may have changed their mind, E9)', () => {
    expect(shouldPromptForLlm('declined', true, false)).toBe(true);
  });
  it('TTY + a real prior choice (local|hosted|configured) → skip (E5)', () => {
    expect(shouldPromptForLlm('local', true, false)).toBe(false);
    expect(shouldPromptForLlm('hosted', true, false)).toBe(false);
    expect(shouldPromptForLlm('configured', true, false)).toBe(false);
  });
  it('non-TTY → never prompt regardless of choice (E1)', () => {
    expect(shouldPromptForLlm(null, false, false)).toBe(false);
    expect(shouldPromptForLlm('declined', false, false)).toBe(false);
  });
  it('--harness present → never prompt even on a TTY (E2)', () => {
    expect(shouldPromptForLlm(null, true, true)).toBe(false);
    expect(shouldPromptForLlm('declined', true, true)).toBe(false);
  });
});

describe('buildProbeConfig — in-process LlmConfig from typed answers', () => {
  it('builds a keyless local config with a SHORT probe timeout', () => {
    const answers: LlmAnswers = { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5' };
    const cfg = buildProbeConfig(answers);
    expect(cfg.baseUrl).toBe('http://localhost:11434/v1');
    expect(cfg.model).toBe('qwen2.5');
    expect(cfg.apiKey).toBeUndefined();
    // The probe must not inherit the 60s default — it injects a short timeout (WARNING-3).
    expect(cfg.timeoutMs).toBe(PROBE_TIMEOUT_MS);
    expect(cfg.timeoutMs).toBeLessThanOrEqual(8000);
  });

  it('threads a hosted key into the config but never widens the timeout', () => {
    const cfg = buildProbeConfig({
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-x',
      apiKey: 'sk-secret',
    });
    expect(cfg.apiKey).toBe('sk-secret');
    expect(cfg.timeoutMs).toBe(PROBE_TIMEOUT_MS);
  });
});

/** A provider that resolves or rejects on demand, never touching the network. */
function fakeProvider(behavior: { ok: true } | { ok: false; err: Error }): LlmProvider {
  return {
    id: 'fake',
    model: 'fake',
    async complete() {
      if (behavior.ok) return { text: 'pong' };
      throw behavior.err;
    },
  };
}

describe('probeLlm — advisory reachability, never throws', () => {
  const cfg: LlmConfig = {
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5',
    timeoutMs: PROBE_TIMEOUT_MS,
  };

  it('resolves {ok:true} when the provider answers', async () => {
    const res = await probeLlm(cfg, { createProvider: () => fakeProvider({ ok: true }) });
    expect(res).toEqual({ ok: true });
  });

  it('resolves {ok:false, detail} when the provider throws (timeout/connrefused) — never rethrows', async () => {
    const res = await probeLlm(cfg, {
      createProvider: () => fakeProvider({ ok: false, err: new Error('ECONNREFUSED') }),
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('ECONNREFUSED');
  });

  it('resolves {ok:false} even when the FACTORY itself throws (no provider) — never rethrows', async () => {
    const res = await probeLlm(cfg, {
      createProvider: () => {
        throw new Error('bad config');
      },
    });
    expect(res.ok).toBe(false);
  });
});

describe('buildExportSnippet — printable export lines, key inline only', () => {
  it('local → keyless export lines (no ABS_LLM_API_KEY), values shell-quoted', () => {
    const snippet = buildExportSnippet({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5',
    });
    expect(snippet).toContain("export ABS_LLM_BASE_URL='http://localhost:11434/v1'");
    expect(snippet).toContain("export ABS_LLM_MODEL='qwen2.5'");
    expect(snippet).not.toContain('ABS_LLM_API_KEY');
  });

  it('hosted → includes the key inline (terminal only) plus both vars, shell-quoted', () => {
    const snippet = buildExportSnippet({
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-x',
      apiKey: 'sk-secret',
    });
    expect(snippet).toContain("export ABS_LLM_BASE_URL='https://api.example.com/v1'");
    expect(snippet).toContain("export ABS_LLM_MODEL='gpt-x'");
    expect(snippet).toContain("export ABS_LLM_API_KEY='sk-secret'");
  });

  it('shell-quotes metacharacters so the snippet is paste-safe (no injection / malformed line)', () => {
    const snippet = buildExportSnippet({
      baseUrl: 'http://h/v1?a=$x;`whoami` &b',
      model: 'm with space',
      apiKey: "sk-it's-tricky",
    });
    // Whole value wrapped in single quotes — metacharacters become literal.
    expect(snippet).toContain("export ABS_LLM_BASE_URL='http://h/v1?a=$x;`whoami` &b'");
    expect(snippet).toContain("export ABS_LLM_MODEL='m with space'");
    // Embedded single quote escaped via the close-reopen `'\''` trick.
    expect(snippet).toContain("export ABS_LLM_API_KEY='sk-it'\\''s-tricky'");
  });
});

// ----------------------------------------- runLlmSetupStep (through the IO seam)

/** A backing kv store + scripted prompts → a `SetupIo` whose `out` is captured. */
function makeIo(opts: {
  isTty: boolean;
  answers?: string[];
  promptReject?: Error;
  /** Reject the (1-based) Nth prompt after answering the earlier ones (E12 on a LATER prompt). */
  rejectAt?: number;
  probe?: (cfg: LlmConfig) => Promise<ProbeResult>;
  env?: Record<string, string | undefined>;
  initialChoice?: LlmChoice | null;
}): {
  io: SetupIo;
  lines: string[];
  kv: Map<string, string>;
  promptedQuestions: string[];
} {
  const lines: string[] = [];
  const kv = new Map<string, string>();
  if (opts.initialChoice != null) kv.set(SETUP_LLM_CHOICE_KEY, opts.initialChoice);
  const queue = [...(opts.answers ?? [])];
  const promptedQuestions: string[] = [];
  const io: SetupIo = {
    isTty: opts.isTty,
    async prompt(q) {
      promptedQuestions.push(q);
      if (opts.promptReject) throw opts.promptReject;
      if (opts.rejectAt != null && promptedQuestions.length === opts.rejectAt)
        throw new Error('readline closed mid-interview');
      const next = queue.shift();
      if (next === undefined) throw new Error('unscripted prompt');
      return next;
    },
    out: (s) => lines.push(s),
    getEnv: (k) => opts.env?.[k],
    probe: opts.probe ?? (async () => ({ ok: true })),
    getChoice: () => (kv.get(SETUP_LLM_CHOICE_KEY) as LlmChoice | undefined) ?? null,
    setChoice: (choice) => {
      kv.set(SETUP_LLM_CHOICE_KEY, choice);
      kv.set(SETUP_LAST_RUN_AT_KEY, new Date().toISOString());
    },
  };
  return { io, lines, kv, promptedQuestions };
}

describe('runLlmSetupStep — non-interactive guard (E1/E2)', () => {
  it('non-TTY → never prompts; sets choice=declined when unset; resolves (exit 0)', async () => {
    const { io, lines, kv, promptedQuestions } = makeIo({ isTty: false });
    await expect(runLlmSetupStep(io, false)).resolves.toBeUndefined();
    expect(promptedQuestions).toEqual([]);
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('declined');
    expect(kv.get(SETUP_LAST_RUN_AT_KEY)).toBeDefined();
    expect(lines).toEqual([]); // silent degraded — no interview copy
  });

  it('--harness present (hasHarnessFlag) → never prompts even when isTty is true (E2)', async () => {
    const { io, promptedQuestions, kv } = makeIo({ isTty: true });
    await runLlmSetupStep(io, true);
    expect(promptedQuestions).toEqual([]);
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('declined');
  });

  it('non-TTY does NOT overwrite a real prior choice (E1 — preserves local)', async () => {
    const { io, kv } = makeIo({ isTty: false, initialChoice: 'local' });
    await runLlmSetupStep(io, false);
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('local');
  });

  it('non-TTY + prior declined → leaves it untouched, no re-write / no lastRunAt bump (FIX 2)', async () => {
    // Seeding only sets the choice key, never lastRunAt — so an absent lastRunAt proves
    // setChoice was NOT called (a re-write would stamp lastRunAt). The prior choice persists.
    const { io, kv } = makeIo({ isTty: false, initialChoice: 'declined' });
    await runLlmSetupStep(io, false);
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('declined');
    expect(kv.get(SETUP_LAST_RUN_AT_KEY)).toBeUndefined(); // setChoice not called → no bump
  });
});

describe('runLlmSetupStep — interview branches', () => {
  it('local (choice 1) → keyless Ollama snippet, choice=local, exit 0', async () => {
    const { io, lines, kv } = makeIo({ isTty: true, answers: ['1'] });
    await runLlmSetupStep(io, false);
    const text = lines.join('\n');
    expect(text).toContain("export ABS_LLM_BASE_URL='http://localhost:11434/v1'");
    expect(text).not.toContain('ABS_LLM_API_KEY');
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('local');
  });

  it('hosted (choice 2) → prompts URL/model/key, snippet WITH key reminder, choice=hosted', async () => {
    const { io, lines, kv, promptedQuestions } = makeIo({
      isTty: true,
      answers: ['2', 'https://api.example.com/v1', 'gpt-x', 'sk-live-123'],
    });
    await runLlmSetupStep(io, false);
    // The choice prompt + the three hosted follow-ups.
    expect(promptedQuestions.length).toBe(4);
    const text = lines.join('\n');
    expect(text).toContain("export ABS_LLM_API_KEY='sk-live-123'");
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('hosted');
  });

  it('skip (choice 3) → choice=declined, no snippet, exit 0', async () => {
    const { io, lines, kv } = makeIo({ isTty: true, answers: ['3'] });
    await runLlmSetupStep(io, false);
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('declined');
    expect(lines.join('\n')).not.toContain('export ABS_LLM_BASE_URL');
  });
});

describe('runLlmSetupStep — probe advisory (E3) never blocks', () => {
  it('probe {ok:false} → warns + still persists the choice + exit 0 (advisory)', async () => {
    const { io, lines, kv } = makeIo({
      isTty: true,
      answers: ['1'],
      probe: async () => ({ ok: false, detail: 'ECONNREFUSED' }),
    });
    await expect(runLlmSetupStep(io, false)).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('Could not reach the LLM');
    // The snippet still prints and the choice is still persisted.
    expect(lines.join('\n')).toContain('export ABS_LLM_BASE_URL');
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('local');
  });

  it('probe {ok:true} → success line + choice persisted', async () => {
    const { io, lines, kv } = makeIo({
      isTty: true,
      answers: ['1'],
      probe: async () => ({ ok: true }),
    });
    await runLlmSetupStep(io, false);
    expect(lines.join('\n')).toContain('Reachable');
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('local');
  });

  it('key pasted into the base-URL field → probe fails → advisory warn, exit 0, no crash (E6)', async () => {
    const { io, lines, kv } = makeIo({
      isTty: true,
      answers: ['2', 'sk-oops-this-is-a-key', 'gpt-x', ''],
      probe: async () => ({ ok: false, detail: 'invalid url' }),
    });
    await expect(runLlmSetupStep(io, false)).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('Could not reach the LLM');
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('hosted');
  });
});

describe('runLlmSetupStep — re-run idempotency (E5)', () => {
  it('prior choice=local → interview skipped, "already" line, NO prompt, choice unchanged', async () => {
    const { io, lines, kv, promptedQuestions } = makeIo({ isTty: true, initialChoice: 'local' });
    await runLlmSetupStep(io, false);
    expect(promptedQuestions).toEqual([]);
    expect(lines.join('\n')).toContain('already done');
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('local');
  });

  it('prior choice=declined on a TTY → RE-OFFERS the interview (E9)', async () => {
    const { io, promptedQuestions, kv } = makeIo({
      isTty: true,
      initialChoice: 'declined',
      answers: ['3'],
    });
    await runLlmSetupStep(io, false);
    expect(promptedQuestions.length).toBeGreaterThan(0); // re-offered
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('declined');
  });
});

describe('runLlmSetupStep — prompt-abort (E12, exit-0 contract)', () => {
  it('a rejected prompt (Ctrl-C/EOF/closed stdin) → choice=declined, resolves (exit 0)', async () => {
    const { io, kv } = makeIo({
      isTty: true,
      promptReject: new Error('readline closed'),
    });
    // Must NOT reject — a thrown rejection would hit main().catch and flip exit to 1.
    await expect(runLlmSetupStep(io, false)).resolves.toBeUndefined();
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('declined');
  });

  it('abort on a LATER prompt (hosted path, key stage) → still resolves (exit 0), choice=declined', async () => {
    // Choice '2' → URL → model answer, then the 4th prompt (the key stage) rejects mid-interview.
    // The reject must be caught the same as a first-prompt abort, never escaping to main().catch.
    const { io, kv, promptedQuestions } = makeIo({
      isTty: true,
      answers: ['2', 'https://api.example.com/v1', 'gpt-x'],
      rejectAt: 4,
    });
    await expect(runLlmSetupStep(io, false)).resolves.toBeUndefined();
    expect(promptedQuestions.length).toBe(4); // got all the way to the key prompt before aborting
    expect(kv.get(SETUP_LLM_CHOICE_KEY)).toBe('declined');
  });
});

describe('runLlmSetupStep — locale ($LANG via the seam)', () => {
  it('renders the PT explanation when LANG=pt_BR', async () => {
    const { io, lines } = makeIo({
      isTty: true,
      answers: ['3'],
      env: { LANG: 'pt_BR.UTF-8' },
    });
    await runLlmSetupStep(io, false);
    expect(lines.join('\n')).toContain('Opcional: conecte um LLM');
  });

  it('renders the EN explanation when LANG=en_US', async () => {
    const { io, lines } = makeIo({
      isTty: true,
      answers: ['3'],
      env: { LANG: 'en_US.UTF-8' },
    });
    await runLlmSetupStep(io, false);
    expect(lines.join('\n')).toContain('Optional: connect an LLM');
  });
});

describe('CRITICAL invariant — the API key is NEVER persisted (kv_meta + abs export)', () => {
  let dir: string;
  let store: MemoryStore;
  const KEY = 'sk-super-secret-live-key-DO-NOT-STORE';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-setup-secret-'));
    store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: 8 }).open();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drives the hosted path with a fake key → no kv_meta value equals the key', async () => {
    // A SetupIo backed by the REAL store's getMeta/setMeta — the production wiring.
    const io: SetupIo = {
      isTty: true,
      prompt: (() => {
        const queue = ['2', 'https://api.example.com/v1', 'gpt-x', KEY];
        return async () => {
          const v = queue.shift();
          if (v === undefined) throw new Error('unscripted');
          return v;
        };
      })(),
      out: () => {},
      getEnv: () => undefined,
      probe: async () => ({ ok: true }),
      getChoice: () => store.getMeta(SETUP_LLM_CHOICE_KEY) as LlmChoice | null,
      setChoice: (choice) => {
        store.setMeta(SETUP_LLM_CHOICE_KEY, choice);
        store.setMeta(SETUP_LAST_RUN_AT_KEY, new Date().toISOString());
      },
    };
    await runLlmSetupStep(io, false);

    expect(store.getMeta(SETUP_LLM_CHOICE_KEY)).toBe('hosted');
    // Full kv_meta scan: NOT ONE value may contain the secret key.
    for (const k of store.listMetaKeys('')) {
      expect(store.getMeta(k) ?? '').not.toContain(KEY);
    }
  });

  it('abs export round-trip contains no ABS_LLM_API_KEY value (export is key-clean)', async () => {
    // Even if a malicious caller tried to stash the key, export never serialises kv_meta.
    store.setMeta(SETUP_LLM_CHOICE_KEY, 'hosted');
    store.setMeta(SETUP_LAST_RUN_AT_KEY, new Date().toISOString());
    const out = join(dir, 'export.jsonl');
    await exportStore(store, out);
    const payload = readFileSync(out, 'utf8');
    expect(payload).not.toContain(KEY);
    expect(payload).not.toContain('ABS_LLM_API_KEY');
  });
});
