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
  /** Is this harness installed on the current machine? Never throws. */
  detect(): Promise<boolean>;
  /** The parity gate — does this harness expose all four pillars? */
  qualifies(): QualifyResult;
  /** Native-event → canonical-moment map. */
  eventMap: EventMap;
  /** Wire the lifecycle (idempotent, backup-first). */
  install(): Promise<InstallReport>;
  /** Remove the lifecycle wiring. */
  uninstall(): Promise<UninstallReport>;
  /** Register the MCP server. `run` is injected by the CLI (no harness→cli coupling). */
  registerMcp(cliPath: string, run: RunFn): Promise<McpRegisterStatus>;
  /** Resolve the session id (+ transcript path) for the current moment. */
  resolveSession(input: ResolveInput): SessionIdentity | null;
}
