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
import { createLlmProvider } from '../llm/index.js';
import type { LlmConfig, LlmProvider } from '../llm/types.js';
import type { Locale } from './locale.js';
import { detectLocale, t } from './locale.js';

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
  /** Harness id baked into the launch command as `start --harness <id>` (#109). */
  harnessId?: string;
}

/** Arg-style options for the add-args / manual-command builders. */
interface ArgStyleOptions {
  argStyle?: 'separator' | 'positional';
  scope?: string;
  /** Harness id appended to the launch command as `start --harness <id>` (#109). */
  harnessId?: string;
}

/** `start` plus the optional `--harness <id>` suffix (#109) — the launched server
 * resolves env-based sessions through this harness instead of a hard-coded
 * claude-code. Omitted → just `start` (byte-identical to the pre-#109 command).
 *
 * `positional` (Gemini) needs an argv terminator before the dash-leading `--harness`
 * arg, or Gemini's yargs parser eats it as a `mcp add` flag and never forwards it to
 * the launched server (Codex review on #109) — leaving Gemini on the claude-code
 * fallback. The separator form already opens with its own `--`, so `--harness` after
 * `start` is unambiguously part of the launched command. */
function startArgs(harnessId: string | undefined, argStyle: ArgStyleOptions['argStyle']): string[] {
  if (!harnessId) return ['start'];
  return argStyle === 'positional'
    ? ['start', '--', '--harness', harnessId]
    : ['start', '--harness', harnessId];
}

/**
 * `<binary> mcp add agentbrainsystem -- node <cli> start [--harness <id>]` (default,
 * claude/codex/copilot) OR the positional `… --scope <scope> node <cli> start [-- --harness <id>]`
 * form for Gemini (#68), which rejects a LEADING `--` separator (yargs parse failure)
 * but needs a terminator before the dash-leading `--harness` arg (#109). The two
 * forms differ only in the add-flag style.
 */
export function buildMcpAddArgs(cliPath: string, opts: ArgStyleOptions = {}): string[] {
  const launch = ['node', cliPath, ...startArgs(opts.harnessId, opts.argStyle)];
  if (opts.argStyle === 'positional') {
    return ['mcp', 'add', MCP_SERVER_NAME, '--scope', opts.scope ?? 'user', ...launch];
  }
  return ['mcp', 'add', MCP_SERVER_NAME, '--', ...launch];
}
export function buildMcpListArgs(): string[] {
  return ['mcp', 'list'];
}
export function buildMcpRemoveArgs(opts: ArgStyleOptions = {}): string[] {
  // The positional/scoped harnesses (Gemini) register with `--scope user`; the
  // remove MUST carry the same scope or it defaults to project scope and leaves the
  // user-scoped server behind (#87). The default (claude/codex) is byte-identical.
  if (opts.argStyle === 'positional') {
    return ['mcp', 'remove', MCP_SERVER_NAME, '--scope', opts.scope ?? 'user'];
  }
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
  const launch = `node ${cliPath} ${startArgs(opts.harnessId, opts.argStyle).join(' ')}`;
  if (opts.argStyle === 'positional') {
    return `${binary} mcp add ${MCP_SERVER_NAME} --scope ${opts.scope ?? 'user'} ${launch}`;
  }
  return `${binary} mcp add ${MCP_SERVER_NAME} -- ${launch}`;
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
  const argStyleOpts: ArgStyleOptions = {
    argStyle: options.argStyle,
    scope: options.scope,
    harnessId: options.harnessId,
  };
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
export function manualMcpRemoveCommand(binary = 'claude', opts: ArgStyleOptions = {}): string {
  if (opts.argStyle === 'positional') {
    return `${binary} mcp remove ${MCP_SERVER_NAME} --scope ${opts.scope ?? 'user'}`;
  }
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
  const argStyleOpts: ArgStyleOptions = { argStyle: options.argStyle, scope: options.scope };
  const manualCommand = manualMcpRemoveCommand(binary, argStyleOpts);

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

  const removed = await run(binary, buildMcpRemoveArgs(argStyleOpts));
  if (removed.code === 0) return { status: 'removed' };
  const message = (removed.stderr || removed.stdout).trim() || `exit ${removed.code}`;
  return { status: 'error', message, manualCommand };
}

// ===================================================================== LLM step
//
// A TTY-gated, guided LLM step appended to `abs setup` (ADR-0018). It explains why an
// LLM sharpens recall, offers local/Ollama → hosted → skip, runs ONE advisory
// reachability probe (never blocks), prints the `export ABS_LLM_*` lines, and persists
// ONLY a non-secret decision marker. The API key is NEVER stored — setup just prints
// the export lines for the user. All decision/IO is funnelled through `SetupIo` so the
// interactive branches are unit-testable without a real TTY or network.

/** Non-secret decision marker — which LLM path the user chose during setup. */
export const SETUP_LLM_CHOICE_KEY = 'setup:llmChoice';
/** Non-secret timestamp of the last `abs setup` run (ISO 8601). */
export const SETUP_LAST_RUN_AT_KEY = 'setup:lastRunAt';

/**
 * What the user decided. `'configured'` is an accepted PRIOR marker (an upgrade may have
 * persisted it); the interview only ever writes `'local'|'hosted'|'declined'`.
 */
export type LlmChoice = 'local' | 'hosted' | 'declined' | 'configured';

/** Short probe timeout (WARNING-3): the probe is advisory, so it must fail fast, not
 * inherit the 60s consolidation default. Injected into the constructed `LlmConfig`. */
export const PROBE_TIMEOUT_MS = 6000;

/** The free-text answers the interview collects. Local needs no key. */
export interface LlmAnswers {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** Result of the advisory probe — never an exception. */
export interface ProbeResult {
  ok: boolean;
  detail?: string;
}

/**
 * Injectable IO seam for the setup interview (WARNING-3). Defaults wire the real env +
 * a readline-on-stderr prompter + the real probe; tests inject scripted answers, a fake
 * probe, `isTty` flags, and a fake env so no real TTY/network is ever touched.
 */
export interface SetupIo {
  /** `process.stdin.isTTY ?? false` in production. */
  isTty: boolean;
  /** Ask one question, resolve the trimmed answer. May reject on Ctrl-C/EOF (E12). */
  prompt: (question: string) => Promise<string>;
  /** Emit a user-facing line (stdout in production). */
  out: (line: string) => void;
  /** Read an env var (for `$LANG` locale detection). */
  getEnv: (key: string) => string | undefined;
  /** Run the advisory reachability probe. */
  probe: (cfg: LlmConfig) => Promise<ProbeResult>;
  /** Read the persisted decision marker (`null` when unset). */
  getChoice: () => LlmChoice | null;
  /** Persist the decision marker + the lastRunAt timestamp. The key is NEVER passed here. */
  setChoice: (choice: LlmChoice) => void;
}

/**
 * Pure decision: should the interactive LLM interview run?
 *   - non-TTY OR `--harness` present → NEVER (scripted/CI path, E1/E2)
 *   - a real prior choice (`local`/`hosted`/`configured`) → skip, no re-nag (E5)
 *   - unset OR `declined` on a TTY → offer (E9 — a declined user may reconsider)
 */
export function shouldPromptForLlm(
  choice: LlmChoice | null,
  isTty: boolean,
  hasHarnessFlag: boolean,
): boolean {
  if (!isTty || hasHarnessFlag) return false;
  if (choice === 'local' || choice === 'hosted' || choice === 'configured') return false;
  return true; // unset | 'declined'
}

/**
 * Build an in-process `LlmConfig` from the typed answers for the probe (WARNING-1):
 * the user's `export`s are NOT in this process yet, so the probe must NOT read
 * `loadConfig()`/env. A SHORT {@link PROBE_TIMEOUT_MS} is injected because the field is
 * required and the probe is advisory — it must fail fast (WARNING-3).
 */
export function buildProbeConfig(answers: LlmAnswers): LlmConfig {
  const cfg: LlmConfig = {
    baseUrl: answers.baseUrl,
    model: answers.model,
    timeoutMs: PROBE_TIMEOUT_MS,
  };
  if (answers.apiKey) cfg.apiKey = answers.apiKey;
  return cfg;
}

/** Injection seam for {@link probeLlm} — defaults to the real provider factory. */
export interface ProbeDeps {
  createProvider?: (cfg: LlmConfig) => LlmProvider;
}

/**
 * ONE advisory reachability probe: a tiny completion against the just-built config.
 * NEVER throws — any failure (unreachable, timeout, bad config, factory error) resolves
 * to `{ ok:false, detail }`. The caller treats `!ok` as a warning and always exits 0.
 */
export async function probeLlm(cfg: LlmConfig, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const create = deps.createProvider ?? createLlmProvider;
  try {
    const provider = create(cfg);
    await provider.complete([{ role: 'user', content: 'ping' }], { temperature: 0 });
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The copy-pasteable `export ABS_LLM_*` snippet. The key is inline ONLY for hosted
 * (terminal display) and is never persisted anywhere by abs — local/Ollama is keyless.
 */
export function buildExportSnippet(answers: LlmAnswers): string {
  const lines = [
    `export ABS_LLM_BASE_URL=${answers.baseUrl}`,
    `export ABS_LLM_MODEL=${answers.model}`,
  ];
  if (answers.apiKey) lines.push(`export ABS_LLM_API_KEY=${answers.apiKey}`);
  return lines.join('\n');
}

/**
 * Run the guided interview through the injected `SetupIo`. Collects answers, runs the
 * advisory probe, prints the export snippet, and returns the choice to persist. A probe
 * failure is advisory only (warn + continue). Throws nothing back to the caller for the
 * happy paths; a prompt rejection (E12) is handled by {@link runLlmSetupStep}, not here.
 */
async function conductInterview(io: SetupIo, locale: Locale): Promise<LlmChoice> {
  io.out('');
  io.out(t(locale, 'explainTitle'));
  io.out(t(locale, 'explainBody'));
  io.out(t(locale, 'optOutCost'));

  const pick = (await io.prompt(t(locale, 'choicePrompt'))).trim();

  if (pick === '1') {
    // Local/Ollama: keyless, sensible defaults the user can edit.
    const answers: LlmAnswers = { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5' };
    return finishChoice(io, locale, answers, 'local');
  }
  if (pick === '2') {
    const baseUrl = (await io.prompt(t(locale, 'askBaseUrl'))).trim();
    const model = (await io.prompt(t(locale, 'askModel'))).trim();
    const apiKey = (await io.prompt(t(locale, 'askApiKey'))).trim();
    const answers: LlmAnswers = { baseUrl, model };
    if (apiKey) answers.apiKey = apiKey;
    return finishChoice(io, locale, answers, 'hosted');
  }
  // Anything else (incl. '3') → skip.
  io.out(t(locale, 'declined'));
  return 'declined';
}

/** Shared tail for the local/hosted branches: probe → snippet → return the choice. */
async function finishChoice(
  io: SetupIo,
  locale: Locale,
  answers: LlmAnswers,
  choice: 'local' | 'hosted',
): Promise<LlmChoice> {
  const result = await io.probe(buildProbeConfig(answers));
  io.out(result.ok ? t(locale, 'probeOk') : t(locale, 'probeFail'));

  io.out('');
  io.out(t(locale, 'snippetHeader'));
  io.out(buildExportSnippet(answers));
  if (answers.apiKey) io.out(t(locale, 'snippetKeyReminder'));
  return choice;
}

/**
 * The guided LLM step appended to `abs setup` (ADR-0018). Always resolves — it NEVER
 * throws and NEVER sets a non-zero exit (invariant 2). Behaviour:
 *   - non-TTY / `--harness` → no prompt; mark `'declined'` ONLY when unset. A prior choice
 *     of any kind (real OR `'declined'`) is left untouched — no re-write, no `lastRunAt`
 *     bump — so a scripted re-run never clobbers a real choice (E1/E2; plan E1).
 *   - prior real choice (`local`/`hosted`/`configured`) → one line, re-persist to refresh
 *     `lastRunAt` (preserving the choice).
 *   - TTY + unset/declined → run the interview; a Ctrl-C/EOF/closed-stdin prompt
 *     rejection (E12) is caught and treated as `'declined'`, exit 0.
 */
export async function runLlmSetupStep(io: SetupIo, hasHarnessFlag: boolean): Promise<void> {
  // Detect the locale from $LANG via the seam.
  const locale = detectLocale(io.getEnv);
  const prior = io.getChoice();

  if (!shouldPromptForLlm(prior, io.isTty, hasHarnessFlag)) {
    // Idempotent re-run with a real prior choice → one line, no prompt; never clobber it (E5).
    if (prior === 'local' || prior === 'hosted' || prior === 'configured') {
      io.out(t(locale, 'alreadyConfigured'));
      io.setChoice(prior); // re-persist (refreshes lastRunAt); preserves the real choice
    } else if (prior == null) {
      // Non-interactive (non-TTY/--harness) FIRST run → silent degraded; mark 'declined'.
      // Iff unset: a prior 'declined' is left untouched (no re-write, no lastRunAt bump) so
      // a scripted re-run can't clobber a real choice (E1/E2; plan E1: don't overwrite).
      io.setChoice('declined');
    }
    return;
  }

  // TTY interview. A rejected prompt (E12) must NOT escape — the top-level main().catch
  // flips the exit code to 1, breaking the exit-0 contract. Catch → 'declined', exit 0.
  let choice: LlmChoice;
  try {
    choice = await conductInterview(io, locale);
  } catch {
    io.out('');
    io.out(t(locale, 'declined'));
    choice = 'declined';
  }
  io.setChoice(choice);
}
