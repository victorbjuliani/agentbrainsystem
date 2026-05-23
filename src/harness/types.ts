// src/harness/types.ts
/**
 * The harness-adapter contract (multi-harness support).
 *
 * Every harness-aware concern lives behind this contract; the core
 * (store / recall / embedding / optimize) never names a harness. An adapter MAPS
 * its harness's native lifecycle events to ~3 canonical moments, so the installer
 * is never hardcoded to one harness's event vocabulary.
 */

/** The canonical lifecycle moments `abs` cares about, regardless of harness. */
export type LifecycleMoment = 'capture' | 'recall' | 'guard';

/** A harness's native event names mapped onto the canonical moments. */
export type EventMap = Record<LifecycleMoment, readonly string[]>;

/** The four parity pillars; an empty `missing` array means the harness qualifies. */
export interface QualifyResult {
  ok: boolean;
  missing: readonly ('capture' | 'recall' | 'mcp' | 'session-id')[];
}

/** Session identity (+ transcript location) for one live session. */
export interface SessionIdentity {
  sessionId: string;
  transcriptPath?: string;
}

/** The minimal input an adapter needs to resolve a session (harness-agnostic). */
export interface ResolveInput {
  payload?: { sessionId?: string; transcriptPath?: string };
  env?: NodeJS.ProcessEnv;
}

export interface InstallReport {
  wired: readonly LifecycleMoment[];
}
export interface UninstallReport {
  removed: readonly LifecycleMoment[];
}

/** Process-spawn result — declared locally so `src/harness` needs no `src/cli` type import. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Structurally compatible with `src/cli/setup.ts`'s `RunFn`. */
export type RunFn = (cmd: string, args: string[]) => Promise<RunResult>;

/** Normalized MCP registration outcome shared by all adapters. */
export type McpRegisterStatus =
  | { status: 'registered' }
  | { status: 'already' }
  | { status: 'unavailable'; manualCommand: string }
  | { status: 'error'; message: string; manualCommand: string };

export interface HarnessAdapter {
  id: string;
  displayName: string;
  /**
   * The CLI binary that owns `mcp add/list/remove` for this harness (e.g. 'claude'
   * or 'codex'). `cmdUninstall` reads this to route the MCP unregister to the right
   * binary (C2). Optional — absent defaults to 'claude' at the call site.
   */
  mcpBinary?: string;
  /**
   * MCP CLI arg style for this harness. Gemini rejects the `--` separator and needs
   * the positional `--scope <scope> node <cli> start` form (#68). `cmdUninstall`
   * reads this (+ `mcpScope`) so the `mcp remove` matches the `mcp add` scope —
   * otherwise a user-scoped server is left behind by a project-scope-defaulting
   * remove (#87). Absent → the `--`/no-scope default (claude/codex).
   */
  mcpArgStyle?: 'separator' | 'positional';
  /** MCP scope for the positional arg style (`--scope user|project`); see `mcpArgStyle`. */
  mcpScope?: 'user' | 'project';
  /**
   * True when this adapter registers its MCP server by editing a config FILE (not via
   * the harness CLI's `mcp add`). OpenCode is the only such adapter — `opencode mcp`
   * has no non-interactive add/remove, so both register AND unregister are file-only.
   * `cmdUninstall` reads this to SKIP the CLI `mcp remove` path (which would hang /
   * fail) — the adapter's own `uninstall()` already removed the config entry.
   */
  mcpFileManaged?: boolean;
  /** Is this harness installed on the current machine? Never throws. */
  detect(): Promise<boolean>;
  /** The parity gate — does this harness expose all four pillars? */
  qualifies(): QualifyResult;
  /** Native-event → canonical-moment map. */
  eventMap: EventMap;
  /**
   * Wire the lifecycle (idempotent, backup-first). `cliPath` is the absolute path to
   * the installed CLI entrypoint (`fileURLToPath(import.meta.url)` from `cli.ts`,
   * threaded by the caller exactly as `registerMcp(cliPath, …)` already is, C2). The
   * four shell-hook adapters accept-and-ignore it (their settings.json / config.toml
   * installers bake no CLI path); the OpenCode adapter bakes it into the absolute
   * `node <cli.js>` invocation in its generated plugin file.
   */
  install(cliPath: string): Promise<InstallReport>;
  /** Remove the lifecycle wiring. */
  uninstall(): Promise<UninstallReport>;
  /** Register the MCP server. `run` is injected by the CLI (no harness→cli coupling). */
  registerMcp(cliPath: string, run: RunFn): Promise<McpRegisterStatus>;
  /** Resolve the session id (+ transcript path) for the current moment. */
  resolveSession(input: ResolveInput): SessionIdentity | null;
}
