/**
 * Hooks module public surface (#15, extended by #16/#19).
 *
 * Sits at the mcp/ingest tier: it wires Claude Code lifecycle hooks (SessionEnd,
 * SessionStart, UserPromptSubmit) into the memory stack. `dispatchHook` is what the
 * CLI's `abs hook <event>` calls; `installHooks` is what `abs install-hooks` calls.
 * Both run behind the non-fatal/timeout contract (ADR-0004).
 */

export type { DispatchOptions } from './dispatch.js';
export { dispatchHook } from './dispatch.js';
export type {
  HookSpec,
  InstallOptions,
  InstallResult,
  UninstallOptions,
  UninstallResult,
} from './installer.js';
export { HOOK_REGISTRY, installHooks, uninstallHooks } from './installer.js';
export type { HookEvent, HookPayload } from './payload.js';
export { buildContextOutput, parseHookPayload, readStdin } from './payload.js';
export { DEFAULT_HOOK_TIMEOUT_MS, runHookSafely } from './runner.js';
export type { TwoSignalInput, TwoSignalVerdict } from './staleness.js';
export {
  evaluateTwoSignalStaleness,
  optimizeCursorKey,
  parseCursor,
  STALENESS_MIN_PENDING,
} from './staleness.js';
