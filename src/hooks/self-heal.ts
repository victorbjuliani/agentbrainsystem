// src/hooks/self-heal.ts
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type InstallOptions, type InstallResult, installHooks } from './installer.js';
import type { HookEvent } from './payload.js';

export interface SelfHealOptions {
  /** The harness that launched the MCP server (`abs start --harness <id>`). */
  harness?: string;
  /** Environment to read the opt-out from (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Hook installer (tests). Defaults to the real installHooks. */
  install?: (opts: InstallOptions) => InstallResult;
  /** Is Claude Code present on this machine? (tests). Defaults to "~/.claude exists". */
  detectClaudeCode?: () => boolean;
  /** Override settings.json path (tests). */
  settingsPath?: string;
  /** One-line notice sink. Defaults to stderr (never stdout — JSON-RPC owns it). */
  log?: (msg: string) => void;
}

export type SelfHealResult =
  | { action: 'restored'; events: HookEvent[] }
  | { action: 'noop' }
  | {
      action: 'skipped';
      reason: 'opt-out' | 'other-harness' | 'not-installed' | 'error';
      detail?: string;
    };

function defaultDetectClaudeCode(): boolean {
  return existsSync(join(homedir(), '.claude'));
}

function stderrLog(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/**
 * Re-assert abs's Claude Code lifecycle hooks at MCP-server startup. The MCP server is
 * registered separately from the hooks (in ~/.claude.json, not settings.json), so it
 * still launches when a third-party rewrite of ~/.claude/settings.json has dropped abs's
 * hooks — making `abs start` the one always-loaded place that can restore them, closing
 * the silent-eviction failure mode for good.
 *
 * Best-effort and FAIL-OPEN: it must never delay or crash the JSON-RPC server. It writes
 * only the settings file (via the idempotent, non-clobbering installHooks; `backup:false`
 * to avoid `.bak` churn) and a single stderr notice when it actually restores something.
 * Restored hooks take effect on the next session (the harness reads settings.json at
 * session start). Opt out with `ABS_SELF_HEAL_HOOKS=0`.
 */
export function selfHealClaudeCodeHooks(opts: SelfHealOptions = {}): SelfHealResult {
  const env = opts.env ?? process.env;
  if (env.ABS_SELF_HEAL_HOOKS === '0') return { action: 'skipped', reason: 'opt-out' };

  // Only the harness that owns ~/.claude/settings.json hooks. Absent (legacy
  // registration) defaults to claude-code, matching startStdio's own default.
  if (opts.harness && opts.harness !== 'claude-code') {
    return { action: 'skipped', reason: 'other-harness' };
  }

  const detect = opts.detectClaudeCode ?? defaultDetectClaudeCode;
  if (!detect()) return { action: 'skipped', reason: 'not-installed' };

  const log = opts.log ?? stderrLog;
  const install = opts.install ?? installHooks;
  const installOpts: InstallOptions = { backup: false };
  if (opts.settingsPath) installOpts.settingsPath = opts.settingsPath;

  try {
    const result = install(installOpts);
    if (result.added.length === 0) return { action: 'noop' };
    log(
      `agentbrainsystem: re-wired ${result.added.length} evicted Claude Code hook(s) ` +
        `(${result.added.join(', ')}) — a tool had rewritten ~/.claude/settings.json and ` +
        'dropped them. Restart this session for capture/recall to take effect.',
    );
    return { action: 'restored', events: result.added };
  } catch (err) {
    // A corrupt or symlinked settings.json (installHooks throws on both) must NEVER
    // crash the MCP server. Surface it on stderr and serve anyway.
    const detail = err instanceof Error ? err.message : String(err);
    log(`agentbrainsystem: hook self-heal skipped (${detail}).`);
    return { action: 'skipped', reason: 'error', detail };
  }
}
