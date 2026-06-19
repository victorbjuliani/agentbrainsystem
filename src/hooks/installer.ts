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
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  /** Tool-name matcher (PreToolUse). Defaults to '' (fires on every event). */
  matcher?: string;
}

export const HOOK_REGISTRY: readonly HookSpec[] = [
  { event: 'SessionEnd', eventArg: 'session-end', timeoutSec: 30 },
  { event: 'SessionStart', eventArg: 'session-start', timeoutSec: 10 },
  { event: 'UserPromptSubmit', eventArg: 'user-prompt-submit', timeoutSec: 10 },
  // The contradiction guard (#29): only Edit/Write can duplicate code, so scope
  // the matcher to them — Read/Bash/etc never spawn the guard. Tight timeout: a
  // single graph point query; it self-bounds and fails open if slower.
  { event: 'PreToolUse', eventArg: 'pre-tool-use', timeoutSec: 5, matcher: 'Edit|Write' },
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

/**
 * Refuse to write through a symlinked settings.json. Resolution here is path-based,
 * so a symlink planted at the target would otherwise be followed by the write and
 * could clobber whatever it points at (e.g. a sensitive file). We never follow it —
 * we throw an actionable error. A missing file is fine (we create it). Any non-ENOENT
 * lstat error propagates.
 */
function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(
        `settings.json at ${path} is a symlink — refusing to write through it. ` +
          'Remove or replace the symlink with a regular file, then re-run.',
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // no file yet — OK
    throw err;
  }
}

/**
 * Atomically write `content` to `path`: write a temp file in the SAME directory, then
 * `rename` it over the target. The rename is atomic on one filesystem, so a crash
 * mid-write can never truncate the user's live settings — a reader sees the old file
 * or the new one, never a torn write. The temp file is cleaned up on a write failure.
 */
function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.abs-settings-tmp-${Date.now()}-${process.pid}`);
  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, path);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // best-effort cleanup — surface the original error below
    }
    throw err;
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

  // Refuse a symlinked settings.json BEFORE reading or mutating — never follow it.
  assertNotSymlink(settingsPath);

  const settings = readSettings(settingsPath);
  const added: HookEvent[] = [];
  const alreadyPresent: HookEvent[] = [];

  // Work on a hooks map we own, preserving every other top-level key.
  const hooks: Record<string, HookMatcherGroup[]> = { ...(settings.hooks ?? {}) };

  for (const spec of specs) {
    const command = `${baseCommand} ${spec.eventArg}`;
    const matcher = spec.matcher ?? '';
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
    // Merge into the existing group with the same matcher when one exists (don't
    // spawn a duplicate); otherwise append a fresh group. Never touch other groups.
    const sameMatcher = groups.find((g) => g.matcher === matcher);
    if (sameMatcher) {
      sameMatcher.hooks.push(entry);
    } else {
      groups.push({ matcher, hooks: [entry] });
    }
    hooks[spec.event] = groups;
    added.push(spec.event);
  }

  let backupPath: string | null = null;
  if (added.length > 0) {
    backupPath = backupSettings(settingsPath);
    const next: ClaudeSettings = { ...settings, hooks };
    // Atomic write (temp + rename) so a crash mid-write can't truncate live settings.
    atomicWriteFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  return { settingsPath, backupPath, added, alreadyPresent };
}

/** The wiring verdict for abs's lifecycle hooks in a harness settings file. */
export interface HookHealth {
  /** The settings file inspected. */
  settingsPath: string;
  /** Registry events whose `abs hook <event>` command is present. */
  present: HookEvent[];
  /** Registry events whose hook command is absent. */
  missing: HookEvent[];
  /** True when every checked registry hook is present (and settings was readable). */
  wired: boolean;
  /** True when settings.json exists but is not valid JSON — wiring unverifiable. */
  unreadable: boolean;
}

export interface CheckHooksOptions {
  /** Override settings.json path (tests). Defaults to ~/.claude/settings.json. */
  settingsPath?: string;
  /** Restrict the check to a subset of events. Defaults to the whole registry. */
  events?: readonly HookEvent[];
}

/**
 * Does this command invoke `abs hook <eventArg>`? Tolerant of how the binary is
 * spelled — `abs hook session-end`, `/usr/local/bin/abs hook session-end`, and
 * `node /path/cli.js hook session-end` all match — by requiring the adjacent token
 * pair `hook <eventArg>` rather than an exact whole-string match. Avoids both false
 * negatives (absolute-path installs) and substring false positives.
 */
function commandMatchesHook(command: string | undefined, eventArg: string): boolean {
  if (!command) return false;
  const parts = command.trim().split(/\s+/);
  const i = parts.indexOf('hook');
  return i >= 0 && parts[i + 1] === eventArg;
}

/**
 * Read-only inverse of {@link installHooks}: report which registry hooks are wired in
 * settings.json. Never mutates and never throws — a missing file means "nothing wired"
 * (all missing, readable); a corrupt file means "cannot verify" (`unreadable`, treated
 * as not wired). Used by `abs doctor` to catch the case where a third-party tool
 * rewrote settings.json and dropped abs's hooks — capture/recall silently OFF while the
 * db itself looks perfectly healthy.
 */
export function checkHooks(options: CheckHooksOptions = {}): HookHealth {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  const events = options.events ?? HOOK_REGISTRY.map((s) => s.event);
  const specs = HOOK_REGISTRY.filter((s) => events.includes(s.event));

  let settings: ClaudeSettings;
  let unreadable = false;
  try {
    settings = readSettings(settingsPath);
  } catch {
    // Corrupt JSON: readSettings throws. We cannot verify wiring — report it.
    settings = {};
    unreadable = true;
  }

  const hooks = settings.hooks ?? {};
  const present: HookEvent[] = [];
  const missing: HookEvent[] = [];
  for (const spec of specs) {
    const groups = hooks[spec.event] ?? [];
    const found = groups.some((g) => {
      const entries = (g as { hooks?: HookCommand[] }).hooks;
      return (
        Array.isArray(entries) && entries.some((h) => commandMatchesHook(h?.command, spec.eventArg))
      );
    });
    (found ? present : missing).push(spec.event);
  }

  return { settingsPath, present, missing, wired: missing.length === 0 && !unreadable, unreadable };
}

export interface UninstallOptions {
  /** Override settings.json path (tests). Defaults to ~/.claude/settings.json. */
  settingsPath?: string;
  /**
   * The command Claude Code runs for each hook — the exact string `install` wrote.
   * Defaults to `abs hook` (eventArg appended). Override to match a non-default
   * install (e.g. an absolute binary path) so the right entries are removed.
   */
  baseCommand?: string;
  /** Restrict removal to a subset of events. Defaults to the whole registry. */
  events?: readonly HookEvent[];
}

export interface UninstallResult {
  settingsPath: string;
  backupPath: string | null;
  /** Events whose hook was found and removed this run. */
  removed: HookEvent[];
  /** Events whose hook was not present (nothing to remove). */
  notPresent: HookEvent[];
}

/**
 * The inverse of {@link installHooks}: remove this project's hooks from settings.json
 * with the same safety contract (symlink-refusing, backup-first, atomic, never
 * clobbering unrelated keys). Identifies our hook by its exact `command` string, so:
 *   - Other tools' hooks SHARING a matcher group with ours are preserved — we drop
 *     only our command from the group's `hooks` array, never the whole group.
 *   - A matcher group left empty *because it held only our hook* is dropped; an
 *     unrelated group (or a pre-existing empty one) is left verbatim.
 *   - An event whose groups all disappear loses its key; if `hooks` empties entirely,
 *     the top-level `hooks` key is removed too.
 * Writes only when at least one hook was removed. A missing settings.json is fine
 * (nothing to remove); a corrupt one throws rather than being silently overwritten.
 */
export function uninstallHooks(options: UninstallOptions = {}): UninstallResult {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  const baseCommand = options.baseCommand ?? 'abs hook';
  const events = options.events ?? HOOK_REGISTRY.map((s) => s.event);
  const specs = HOOK_REGISTRY.filter((s) => events.includes(s.event));

  // Refuse a symlinked settings.json BEFORE reading or mutating — never follow it.
  assertNotSymlink(settingsPath);

  const settings = readSettings(settingsPath);
  const removed: HookEvent[] = [];
  const notPresent: HookEvent[] = [];

  const hooks: Record<string, HookMatcherGroup[]> = { ...(settings.hooks ?? {}) };

  for (const spec of specs) {
    const command = `${baseCommand} ${spec.eventArg}`;
    const groups = hooks[spec.event];
    if (!groups) {
      notPresent.push(spec.event);
      continue;
    }

    let found = false;
    const nextGroups: HookMatcherGroup[] = [];
    for (const g of groups) {
      if (!g.hooks.some((h) => h.command === command)) {
        nextGroups.push(g); // not ours — preserve verbatim
        continue;
      }
      found = true;
      const keptHooks = g.hooks.filter((h) => h.command !== command);
      // Keep the group only if other hooks remain; an ours-only group disappears.
      if (keptHooks.length > 0) nextGroups.push({ ...g, hooks: keptHooks });
    }

    if (!found) {
      notPresent.push(spec.event);
      continue;
    }
    removed.push(spec.event);
    if (nextGroups.length > 0) hooks[spec.event] = nextGroups;
    else delete hooks[spec.event];
  }

  let backupPath: string | null = null;
  if (removed.length > 0) {
    backupPath = backupSettings(settingsPath);
    const next: ClaudeSettings = { ...settings, hooks };
    // Don't leave an empty `hooks: {}` behind once we've removed our last entry.
    if (Object.keys(hooks).length === 0) delete (next as ClaudeSettings).hooks;
    atomicWriteFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  return { settingsPath, backupPath, removed, notPresent };
}
