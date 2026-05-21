/**
 * Idempotent, backup-first installer for the Claude Code hooks (#15, extended by
 * #16 and #19). Owns the ONLY code that mutates `~/.claude/settings.json`.
 *
 * Design (ADR-0004):
 *   - A single `HOOK_REGISTRY` keyed by event drives everything — adding a hook in
 *     #16/#19 is one registry entry, not a new bespoke writer.
 *   - Idempotent: a hook is identified by its exact `command` string; re-running
 *     `install` is a no-op for already-present hooks (no duplicates).
 *   - Backup-first: before any mutation we copy settings.json to a timestamped
 *     `.bak` next to it, so a bad merge is always recoverable.
 *   - Never clobber unrelated keys. We read the full settings object, mutate only
 *     `hooks.<Event>`, and merge into the EXISTING matcher group rather than
 *     replacing the array — other tools' hooks (and the user's own) are preserved.
 *   - Opt-in: nothing here runs unless the user invokes `abs install-hooks`.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HookEvent } from './payload.js';

/** A single registered hook entry as it appears under `hooks.<Event>[].hooks[]`. */
interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

/** One matcher group under `hooks.<Event>`. */
interface HookMatcherGroup {
  matcher: string;
  hooks: HookCommand[];
}

/** The slice of settings.json we touch. Unknown keys are preserved verbatim. */
interface ClaudeSettings {
  hooks?: Record<string, HookMatcherGroup[]>;
  [key: string]: unknown;
}

/**
 * The registry: which events this project registers and how. The command is built
 * from the resolved `abs` binary so the same entry works whether installed globally
 * or run via an explicit path. `timeoutSec` is the settings.json-level timeout
 * (the handler also self-bounds tighter per ADR-0004).
 */
export interface HookSpec {
  event: HookEvent;
  /** CLI subcommand passed to `abs hook <event-arg>`. */
  eventArg: string;
  /** settings.json hook timeout, seconds. */
  timeoutSec: number;
}

export const HOOK_REGISTRY: readonly HookSpec[] = [
  { event: 'SessionEnd', eventArg: 'session-end', timeoutSec: 30 },
  { event: 'SessionStart', eventArg: 'session-start', timeoutSec: 10 },
  { event: 'UserPromptSubmit', eventArg: 'user-prompt-submit', timeoutSec: 10 },
];

export interface InstallOptions {
  /** Override settings.json path (tests). Defaults to ~/.claude/settings.json. */
  settingsPath?: string;
  /**
   * The command Claude Code should run for each hook. Defaults to `abs hook`.
   * The eventArg is appended, e.g. `abs hook session-end`. Override in tests or to
   * pin an absolute binary path.
   */
  baseCommand?: string;
  /** Restrict installation to a subset of events. Defaults to the whole registry. */
  events?: readonly HookEvent[];
}

export interface InstallResult {
  settingsPath: string;
  backupPath: string | null;
  /** Events whose hook was newly added this run. */
  added: HookEvent[];
  /** Events whose hook was already present (idempotent no-op). */
  alreadyPresent: HookEvent[];
}

function defaultSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

/** Read settings.json into an object, tolerating a missing file (→ empty settings). */
function readSettings(path: string): ClaudeSettings {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {}; // no settings yet — we'll create it
  }
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as ClaudeSettings) : {};
  } catch {
    // A corrupt settings.json is not ours to silently overwrite.
    throw new Error(`settings.json at ${path} is not valid JSON — refusing to mutate it`);
  }
}

/** Timestamped backup beside the settings file. Returns null when there's nothing to back up. */
function backupSettings(path: string): string | null {
  let exists = true;
  try {
    readFileSync(path);
  } catch {
    exists = false;
  }
  if (!exists) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.${stamp}.bak`;
  copyFileSync(path, backupPath);
  return backupPath;
}

/**
 * Register the project's hooks. Idempotent + backup-first + non-clobbering.
 * Returns which events were added vs already present. Writes settings.json only
 * when at least one hook was added.
 */
export function installHooks(options: InstallOptions = {}): InstallResult {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  const baseCommand = options.baseCommand ?? 'abs hook';
  const events = options.events ?? HOOK_REGISTRY.map((s) => s.event);
  const specs = HOOK_REGISTRY.filter((s) => events.includes(s.event));

  const settings = readSettings(settingsPath);
  const added: HookEvent[] = [];
  const alreadyPresent: HookEvent[] = [];

  // Work on a hooks map we own, preserving every other top-level key.
  const hooks: Record<string, HookMatcherGroup[]> = { ...(settings.hooks ?? {}) };

  for (const spec of specs) {
    const command = `${baseCommand} ${spec.eventArg}`;
    const groups = (hooks[spec.event] ?? []).map((g) => ({ ...g, hooks: [...g.hooks] }));

    // Idempotency: our hook is identified by its exact command string, anywhere
    // under this event (any matcher group).
    const present = groups.some((g) => g.hooks.some((h) => h.command === command));
    if (present) {
      alreadyPresent.push(spec.event);
      hooks[spec.event] = groups;
      continue;
    }

    const entry: HookCommand = { type: 'command', command, timeout: spec.timeoutSec };
    // Merge into the existing empty-matcher group when one exists (don't spawn a
    // second '' group); otherwise append a fresh group. Never touch other groups.
    const emptyGroup = groups.find((g) => g.matcher === '');
    if (emptyGroup) {
      emptyGroup.hooks.push(entry);
    } else {
      groups.push({ matcher: '', hooks: [entry] });
    }
    hooks[spec.event] = groups;
    added.push(spec.event);
  }

  let backupPath: string | null = null;
  if (added.length > 0) {
    backupPath = backupSettings(settingsPath);
    const next: ClaudeSettings = { ...settings, hooks };
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }

  return { settingsPath, backupPath, added, alreadyPresent };
}
