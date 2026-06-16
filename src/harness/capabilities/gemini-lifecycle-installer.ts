/**
 * Gemini CLI lifecycle installer (#68).
 *
 * Gemini hooks live in `~/.gemini/settings.json` under a top-level `hooks` key —
 * the SAME logical shape as Claude's settings.json (`hooks.<Event>[]` matcher
 * groups with `{type:"command", command, timeout?}` entries) — but the EVENT
 * NAMES differ (`SessionEnd`/`SessionStart`/`BeforeAgent`/`BeforeTool`, verified
 * against gemini-cli-core v0.35.0). `HOOK_REGISTRY` in `src/hooks/installer.ts`
 * is hardcoded to Claude event names and cannot emit Gemini keys, so this is a
 * self-contained installer — mirroring the Codex precedent
 * (`codex-lifecycle-installer.ts`, which owns its own TOML writer). The four tiny
 * safety helpers (`assertNotSymlink`/`backup`/`atomicWrite`/`readSettings`) are
 * copied PRIVATELY here exactly as Codex copied its own; `installer.ts` stays
 * BYTE-IDENTICAL (no move, no shared `settings-io.ts` — out of scope for #68).
 *
 * We own ONLY our managed `{type:'command', command:'<base> <arg>'}` entries,
 * identified by exact command string. Every other key (notably `mcpServers`
 * written by the MCP registrar, and the user's own hooks) is preserved verbatim.
 * Safety contract mirrors the Claude/Codex installers: symlink-refusal,
 * backup-first (only when something changed), atomic temp+rename.
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
import type { InstallReport, LifecycleMoment, UninstallReport } from '../types.js';

/** Gemini native event → canonical moment + the `abs hook` arg the existing handler uses. */
export interface GeminiHookSpec {
  event: string;
  moment: LifecycleMoment;
  arg: string;
  matcher: string;
  timeout: number;
}
export const GEMINI_HOOKS: readonly GeminiHookSpec[] = [
  { event: 'SessionEnd', moment: 'capture', arg: 'session-end', matcher: '', timeout: 30 },
  { event: 'SessionStart', moment: 'recall', arg: 'session-start', matcher: '', timeout: 10 },
  { event: 'BeforeAgent', moment: 'recall', arg: 'user-prompt-submit', matcher: '', timeout: 10 },
  { event: 'BeforeTool', moment: 'guard', arg: 'pre-tool-use', matcher: 'Edit|Write', timeout: 5 },
];

export interface GeminiInstallerOptions {
  settingsPath?: string;
  baseCommand?: string;
}

export interface LifecycleInstaller {
  install(): Promise<InstallReport>;
  uninstall(): Promise<UninstallReport>;
}

interface CommandHook {
  type: 'command';
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  sequential?: boolean;
  hooks: CommandHook[];
}
type HookMap = Record<string, HookGroup[]>;
interface Settings {
  hooks?: HookMap;
  [key: string]: unknown;
}

function defaultSettingsPath(): string {
  return join(homedir(), '.gemini', 'settings.json');
}

// --- safety helpers (copied privately, Codex precedent; installer.ts untouched) ---
function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`settings.json at ${path} is a symlink — refusing to write through it.`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
function readSettings(path: string): Settings {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Settings) : {};
  } catch {
    return {}; // missing or malformed → start fresh (the user's bytes are preserved via backup)
  }
}
/**
 * Is the file PRESENT-but-unparseable? (#159 F2-02) A truly MISSING file (ENOENT) is a
 * silent fresh start — fine. But a present file whose JSON we cannot parse means the
 * caller is about to replace the user's config, so it must warn (not silently clobber).
 */
function isMalformedPresent(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return false; // ENOENT / unreadable → not "present-but-malformed"
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed !== 'object' || parsed === null; // valid JSON but not an object
  } catch {
    return true; // present + unparseable
  }
}
function backupSettings(path: string): string | undefined {
  try {
    readFileSync(path);
  } catch {
    return undefined;
  }
  const backupPath = `${path}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  copyFileSync(path, backupPath);
  return backupPath;
}
function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.abs-gemini-tmp-${Date.now()}-${process.pid}`);
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

const MOMENTS: LifecycleMoment[] = [...new Set(GEMINI_HOOKS.map((h) => h.moment))];

/** Our managed command string for a spec (the identity we add/skip/remove by). */
function commandFor(baseCommand: string, spec: GeminiHookSpec): string {
  return `${baseCommand} ${spec.arg}`;
}

/** Does any group under this event already carry our exact managed command? */
function hasManaged(groups: HookGroup[] | undefined, command: string): boolean {
  return (groups ?? []).some((g) => g.hooks?.some((h) => h.command === command));
}

export function geminiLifecycleInstaller(options: GeminiInstallerOptions = {}): LifecycleInstaller {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  const baseCommand = options.baseCommand ?? 'abs hook';
  return {
    install: async () => {
      assertNotSymlink(settingsPath);
      const before = (() => {
        try {
          return readFileSync(settingsPath, 'utf8');
        } catch {
          return undefined;
        }
      })();
      // #159 (F2-02): a present-but-unparseable file is about to be replaced. Detect it
      // now so we can warn (naming the file + backup) AFTER the backup is taken below.
      const malformed = isMalformedPresent(settingsPath);
      const settings = readSettings(settingsPath);
      const hooks: HookMap = { ...(settings.hooks ?? {}) };
      for (const spec of GEMINI_HOOKS) {
        const command = commandFor(baseCommand, spec);
        const existing = hooks[spec.event];
        const groups = existing ? [...existing] : [];
        if (hasManaged(groups, command)) {
          hooks[spec.event] = groups; // already wired — idempotent
          continue;
        }
        const entry: CommandHook = { type: 'command', command, timeout: spec.timeout };
        // Merge into a same-matcher group when one exists, else append a fresh group.
        const sameMatcher = groups.find((g) => (g.matcher ?? '') === spec.matcher);
        if (sameMatcher) sameMatcher.hooks = [...sameMatcher.hooks, entry];
        else groups.push({ matcher: spec.matcher, hooks: [entry] });
        hooks[spec.event] = groups;
      }
      const next = { ...settings, hooks };
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      const report: InstallReport = { wired: MOMENTS };
      if (serialized === before) return report; // true no-op: no backup, no write
      const backupPath = backupSettings(settingsPath);
      atomicWriteFile(settingsPath, serialized);
      // Kill the silence (#159 F2-02): a malformed config WAS replaced — tell the user
      // where the original bytes went. Install still succeeds (we do NOT abort).
      if (malformed) {
        process.stderr.write(
          `[abs] WARNING: ${settingsPath} was not valid JSON and has been replaced with a ` +
            `fresh agentbrainsystem config.${
              backupPath ? ` Your original bytes are preserved at ${backupPath}.` : ''
            }\n`,
        );
      }
      return report;
    },
    uninstall: async () => {
      assertNotSymlink(settingsPath);
      const before = (() => {
        try {
          return readFileSync(settingsPath, 'utf8');
        } catch {
          return undefined;
        }
      })();
      if (before === undefined) return { removed: [] };
      const settings = readSettings(settingsPath);
      if (!settings.hooks) return { removed: [] };
      const ourCommands = new Set(GEMINI_HOOKS.map((s) => commandFor(baseCommand, s)));
      const removed = new Set<LifecycleMoment>();
      const hooks: HookMap = {};
      for (const [event, groups] of Object.entries(settings.hooks)) {
        const moment = GEMINI_HOOKS.find((s) => s.event === event)?.moment;
        const keptGroups: HookGroup[] = [];
        for (const g of groups) {
          const keptHooks = g.hooks.filter((h) => {
            const ours = ourCommands.has(h.command);
            if (ours && moment) removed.add(moment);
            return !ours;
          });
          if (keptHooks.length > 0) keptGroups.push({ ...g, hooks: keptHooks });
        }
        if (keptGroups.length > 0) hooks[event] = keptGroups; // drop empty event keys
      }
      const next: Settings = { ...settings };
      if (Object.keys(hooks).length > 0) next.hooks = hooks;
      else delete next.hooks;
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      if (serialized === before) return { removed: [] };
      backupSettings(settingsPath);
      atomicWriteFile(settingsPath, serialized);
      return { removed: [...removed] };
    },
  };
}
