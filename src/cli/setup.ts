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

/** The `claude mcp add …` argv that registers this CLI as a stdio MCP server. */
export function buildClaudeMcpAddArgs(cliPath: string): string[] {
  return ['mcp', 'add', MCP_SERVER_NAME, '--', 'node', cliPath, 'start'];
}

/** The copy-pasteable command shown when auto-registration isn't possible. */
export function manualMcpCommand(cliPath: string): string {
  return `claude mcp add ${MCP_SERVER_NAME} -- node ${cliPath} start`;
}

/**
 * Register the MCP server with Claude Code, idempotently:
 *   1. probe `claude --version` — absent ⇒ `no-claude` (caller prints the manual command)
 *   2. `claude mcp list` already lists the server ⇒ `already`
 *   3. `claude mcp add …` ⇒ `registered`, or `error` with the captured message
 */
export async function registerMcpServer(cliPath: string, run: RunFn): Promise<RegisterResult> {
  const manualCommand = manualMcpCommand(cliPath);

  let probe: RunResult;
  try {
    probe = await run('claude', ['--version']);
  } catch {
    return { status: 'no-claude', manualCommand };
  }
  if (probe.code !== 0) return { status: 'no-claude', manualCommand };

  try {
    const list = await run('claude', ['mcp', 'list']);
    if (list.code === 0 && list.stdout.includes(MCP_SERVER_NAME)) {
      return { status: 'already' };
    }
  } catch {
    // listing failed — fall through and attempt the add anyway
  }

  const added = await run('claude', buildClaudeMcpAddArgs(cliPath));
  if (added.code === 0) return { status: 'registered' };
  const message = (added.stderr || added.stdout).trim() || `exit ${added.code}`;
  return { status: 'error', message, manualCommand };
}

/** The `claude mcp remove …` argv that unregisters this CLI as a stdio MCP server. */
export function buildClaudeMcpRemoveArgs(): string[] {
  return ['mcp', 'remove', MCP_SERVER_NAME];
}

/** The copy-pasteable command shown when auto-unregistration isn't possible. */
export function manualMcpRemoveCommand(): string {
  return `claude mcp remove ${MCP_SERVER_NAME}`;
}

export type UnregisterResult =
  | { status: 'removed' }
  | { status: 'not-registered' }
  | { status: 'no-claude'; manualCommand: string }
  | { status: 'error'; message: string; manualCommand: string };

/**
 * Unregister the MCP server from Claude Code, idempotently — the inverse of
 * {@link registerMcpServer}:
 *   1. probe `claude --version` — absent ⇒ `no-claude` (caller prints the manual command)
 *   2. `claude mcp list` does NOT list the server ⇒ `not-registered`
 *   3. `claude mcp remove …` ⇒ `removed`, or `error` with the captured message
 */
export async function unregisterMcpServer(run: RunFn): Promise<UnregisterResult> {
  const manualCommand = manualMcpRemoveCommand();

  let probe: RunResult;
  try {
    probe = await run('claude', ['--version']);
  } catch {
    return { status: 'no-claude', manualCommand };
  }
  if (probe.code !== 0) return { status: 'no-claude', manualCommand };

  try {
    const list = await run('claude', ['mcp', 'list']);
    if (list.code === 0 && !list.stdout.includes(MCP_SERVER_NAME)) {
      return { status: 'not-registered' };
    }
  } catch {
    // listing failed — fall through and attempt the remove anyway
  }

  const removed = await run('claude', buildClaudeMcpRemoveArgs());
  if (removed.code === 0) return { status: 'removed' };
  const message = (removed.stderr || removed.stdout).trim() || `exit ${removed.code}`;
  return { status: 'error', message, manualCommand };
}
