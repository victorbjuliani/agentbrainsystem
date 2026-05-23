/**
 * `abs setup` core — one-shot onboarding that wires this CLI into Claude Code as a
 * stdio MCP server. The Claude CLI is invoked through an injectable `run` function,
 * so the decision logic (detect → idempotent check → register) is unit-testable
 * without spawning real processes.
 *
 * Non-fatal by design: a missing `claude` CLI (e.g. Windows .cmd shim, or not
 * installed) degrades to a printed manual command — never an error or a crash.
 * The real `run` (in cli.ts) uses `execFile` (no shell ⇒ no command injection).
 */
export const MCP_SERVER_NAME = 'agentbrainsystem';

export interface RunResult {
  /** Process exit code, or `null` when the binary could not be spawned at all. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command + args and capture its result. Never rejects — a spawn failure is `code: null`. */
export type RunFn = (cmd: string, args: string[]) => Promise<RunResult>;

export type RegisterResult =
  | { status: 'registered' }
  | { status: 'already' }
  | { status: 'no-claude'; manualCommand: string }
  | { status: 'error'; message: string; manualCommand: string };

/** Options shared by register/unregister — selects the CLI binary that owns `mcp add/list/remove`. */
export interface McpRegisterOptions {
  /** CLI binary that owns `mcp add/list/remove` (defaults to 'claude'). */
  binary?: string;
  /** Gemini rejects the `--` separator; it needs positional args + an explicit scope (#68). */
  argStyle?: 'separator' | 'positional';
  /** Scope for the positional style (`--scope user|project`); positional only. */
  scope?: 'user' | 'project';
}

/** Arg-style options for the add-args / manual-command builders. */
interface ArgStyleOptions {
  argStyle?: 'separator' | 'positional';
  scope?: string;
}

/**
 * `<binary> mcp add agentbrainsystem -- node <cli> start` (default, claude/codex)
 * OR the positional `… --scope <scope> node <cli> start` form for Gemini (#68),
 * which rejects the `--` separator (yargs parse failure). The default is byte-identical.
 */
export function buildMcpAddArgs(cliPath: string, opts: ArgStyleOptions = {}): string[] {
  if (opts.argStyle === 'positional') {
    return [
      'mcp',
      'add',
      MCP_SERVER_NAME,
      '--scope',
      opts.scope ?? 'user',
      'node',
      cliPath,
      'start',
    ];
  }
  return ['mcp', 'add', MCP_SERVER_NAME, '--', 'node', cliPath, 'start'];
}
export function buildMcpListArgs(): string[] {
  return ['mcp', 'list'];
}
export function buildMcpRemoveArgs(): string[] {
  return ['mcp', 'remove', MCP_SERVER_NAME];
}

/** Back-compat aliases (Claude-named callers/tests keep working). */
export const buildClaudeMcpAddArgs = buildMcpAddArgs;
export const buildClaudeMcpRemoveArgs = buildMcpRemoveArgs;

/**
 * The copy-pasteable command shown when auto-registration isn't possible. Threads
 * the same arg style as {@link buildMcpAddArgs} (W2, #68) so the printed Gemini
 * fallback is the POSITIONAL form Gemini accepts — never the rejected `--` form.
 * The default keeps the Claude/Codex `--` form byte-identical.
 */
export function manualMcpCommand(
  cliPath: string,
  binary = 'claude',
  opts: ArgStyleOptions = {},
): string {
  if (opts.argStyle === 'positional') {
    return `${binary} mcp add ${MCP_SERVER_NAME} --scope ${opts.scope ?? 'user'} node ${cliPath} start`;
  }
  return `${binary} mcp add ${MCP_SERVER_NAME} -- node ${cliPath} start`;
}

/**
 * Register the MCP server with the harness CLI, idempotently:
 *   1. probe `<binary> --version` — absent ⇒ `no-claude` (caller prints the manual command)
 *   2. `<binary> mcp list` already lists the server ⇒ `already`
 *   3. `<binary> mcp add …` ⇒ `registered`, or `error` with the captured message
 */
export async function registerMcpServer(
  cliPath: string,
  run: RunFn,
  options: McpRegisterOptions = {},
): Promise<RegisterResult> {
  const binary = options.binary ?? 'claude';
  const argStyleOpts: ArgStyleOptions = { argStyle: options.argStyle, scope: options.scope };
  const manualCommand = manualMcpCommand(cliPath, binary, argStyleOpts);

  let probe: RunResult;
  try {
    probe = await run(binary, ['--version']);
  } catch {
    return { status: 'no-claude', manualCommand };
  }
  if (probe.code !== 0) return { status: 'no-claude', manualCommand };

  try {
    const list = await run(binary, buildMcpListArgs());
    if (list.code === 0 && list.stdout.includes(MCP_SERVER_NAME)) {
      return { status: 'already' };
    }
  } catch {
    // listing failed — fall through and attempt the add anyway
  }

  const added = await run(binary, buildMcpAddArgs(cliPath, argStyleOpts));
  if (added.code === 0) return { status: 'registered' };
  const message = (added.stderr || added.stdout).trim() || `exit ${added.code}`;
  return { status: 'error', message, manualCommand };
}

/** The copy-pasteable command shown when auto-unregistration isn't possible. */
export function manualMcpRemoveCommand(binary = 'claude'): string {
  return `${binary} mcp remove ${MCP_SERVER_NAME}`;
}

export type UnregisterResult =
  | { status: 'removed' }
  | { status: 'not-registered' }
  | { status: 'no-claude'; manualCommand: string }
  | { status: 'error'; message: string; manualCommand: string };

/**
 * Unregister the MCP server from the harness CLI, idempotently — the inverse of
 * {@link registerMcpServer}:
 *   1. probe `<binary> --version` — absent ⇒ `no-claude` (caller prints the manual command)
 *   2. `<binary> mcp list` does NOT list the server ⇒ `not-registered`
 *   3. `<binary> mcp remove …` ⇒ `removed`, or `error` with the captured message
 */
export async function unregisterMcpServer(
  run: RunFn,
  options: McpRegisterOptions = {},
): Promise<UnregisterResult> {
  const binary = options.binary ?? 'claude';
  const manualCommand = manualMcpRemoveCommand(binary);

  let probe: RunResult;
  try {
    probe = await run(binary, ['--version']);
  } catch {
    return { status: 'no-claude', manualCommand };
  }
  if (probe.code !== 0) return { status: 'no-claude', manualCommand };

  try {
    const list = await run(binary, buildMcpListArgs());
    if (list.code === 0 && !list.stdout.includes(MCP_SERVER_NAME)) {
      return { status: 'not-registered' };
    }
  } catch {
    // listing failed — fall through and attempt the remove anyway
  }

  const removed = await run(binary, buildMcpRemoveArgs());
  if (removed.code === 0) return { status: 'removed' };
  const message = (removed.stderr || removed.stdout).trim() || `exit ${removed.code}`;
  return { status: 'error', message, manualCommand };
}
