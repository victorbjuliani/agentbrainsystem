/**
 * GitHub Copilot CLI lifecycle installer (#69).
 *
 * Copilot hooks live in `~/.copilot/hooks.json` — a FLAT JSON map, NOT Claude's
 * nested matcher groups: `{ hooks: { <event>: [ {type:'command', bash:'<cmd>'} ] },
 * version: 1 }`. The entry key is `bash` (a single shell command line), NOT
 * `command`, and there is no `matcher` wrapper. Verified against a real installed
 * plugin's `hooks.json` and the SDK's bundled zod hooks schema (copilot v1.0.51).
 *
 * The config event keys are the SDK's zod names: `sessionEnd` (capture),
 * `sessionStart` + `userPromptSubmitted` (recall), `preToolUse` (guard). NOTE:
 * `userPromptSubmitted` is the correct key — `userPromptSubmit` is invalid in the
 * SDK schema and silently never fires (a known third-party-plugin bug).
 *
 * `HOOK_REGISTRY` in `src/hooks/installer.ts` is hardcoded to Claude event names
 * and cannot emit Copilot keys, so this is a self-contained installer — mirroring
 * the Codex/Gemini precedent. The four tiny safety helpers
 * (`assertNotSymlink`/`readConfig`/`backup`/`atomicWrite`) are copied PRIVATELY
 * here exactly as Codex/Gemini copied their own; `installer.ts` stays
 * BYTE-IDENTICAL (no move, no shared `settings-io.ts` — out of scope for #69).
 *
 * We own ONLY our managed `{type:'command', bash:'<base> <arg>'}` entries,
 * identified by exact bash string. Every other key (the user's own hooks, any
 * foreign top-level field, and `version`) is preserved verbatim. Safety contract
 * mirrors the Claude/Codex/Gemini installers: symlink-refusal, backup-first (only
 * when something changed), atomic temp+rename.
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

/** Copilot native event → canonical moment + the `abs hook` arg the existing handler uses. */
export interface CopilotHookSpec {
  event: string;
  moment: LifecycleMoment;
  arg: string;
}
export const COPILOT_HOOKS: readonly CopilotHookSpec[] = [
  { event: 'sessionEnd', moment: 'capture', arg: 'session-end' },
  { event: 'sessionStart', moment: 'recall', arg: 'session-start' },
  // SDK zod key is `userPromptSubmitted` — `userPromptSubmit` is invalid (silent no-fire).
  { event: 'userPromptSubmitted', moment: 'recall', arg: 'user-prompt-submit' },
  { event: 'preToolUse', moment: 'guard', arg: 'pre-tool-use' },
];

export interface CopilotInstallerOptions {
  hooksPath?: string;
  baseCommand?: string;
}

export interface LifecycleInstaller {
  install(): Promise<InstallReport>;
  uninstall(): Promise<UninstallReport>;
}

interface CopilotHookEntry {
  type: 'command';
  bash: string;
}
type HookMap = Record<string, CopilotHookEntry[]>;
interface CopilotConfig {
  hooks?: HookMap;
  version?: number;
  [key: string]: unknown;
}

function defaultHooksPath(): string {
  return join(homedir(), '.copilot', 'hooks.json');
}

// --- safety helpers (copied privately, Codex/Gemini precedent; installer.ts untouched) ---
function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`hooks.json at ${path} is a symlink — refusing to write through it.`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
function readConfig(path: string): CopilotConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as CopilotConfig) : {};
  } catch {
    return {}; // missing or malformed → start fresh (the user's bytes are preserved via backup)
  }
}
function backupConfig(path: string): void {
  try {
    readFileSync(path);
  } catch {
    return;
  }
  copyFileSync(path, `${path}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
}
function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.abs-copilot-tmp-${Date.now()}-${process.pid}`);
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

const MOMENTS: LifecycleMoment[] = [...new Set(COPILOT_HOOKS.map((h) => h.moment))];

/** Our managed bash string for a spec (the identity we add/skip/remove by). */
function bashFor(baseCommand: string, spec: CopilotHookSpec): string {
  return `${baseCommand} ${spec.arg}`;
}

export function copilotLifecycleInstaller(
  options: CopilotInstallerOptions = {},
): LifecycleInstaller {
  const hooksPath = options.hooksPath ?? defaultHooksPath();
  const baseCommand = options.baseCommand ?? 'abs hook';
  return {
    install: async () => {
      assertNotSymlink(hooksPath);
      const before = (() => {
        try {
          return readFileSync(hooksPath, 'utf8');
        } catch {
          return undefined;
        }
      })();
      const config = readConfig(hooksPath);
      const hooks: HookMap = { ...(config.hooks ?? {}) };
      for (const spec of COPILOT_HOOKS) {
        const bash = bashFor(baseCommand, spec);
        const entries = hooks[spec.event] ? [...(hooks[spec.event] as CopilotHookEntry[])] : [];
        if (entries.some((e) => e.bash === bash)) {
          hooks[spec.event] = entries; // already wired — idempotent
          continue;
        }
        entries.push({ type: 'command', bash });
        hooks[spec.event] = entries;
      }
      const next = { ...config, hooks, version: config.version ?? 1 };
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      const report: InstallReport = { wired: MOMENTS };
      if (serialized === before) return report; // true no-op: no backup, no write
      backupConfig(hooksPath);
      atomicWriteFile(hooksPath, serialized);
      return report;
    },
    uninstall: async () => {
      assertNotSymlink(hooksPath);
      const before = (() => {
        try {
          return readFileSync(hooksPath, 'utf8');
        } catch {
          return undefined;
        }
      })();
      if (before === undefined) return { removed: [] };
      const config = readConfig(hooksPath);
      if (!config.hooks) return { removed: [] };
      const ourBashes = new Set(COPILOT_HOOKS.map((s) => bashFor(baseCommand, s)));
      const removed = new Set<LifecycleMoment>();
      const hooks: HookMap = {};
      for (const [event, entries] of Object.entries(config.hooks)) {
        const moment = COPILOT_HOOKS.find((s) => s.event === event)?.moment;
        const kept = entries.filter((e) => {
          const ours = ourBashes.has(e.bash);
          if (ours && moment) removed.add(moment);
          return !ours;
        });
        if (kept.length > 0) hooks[event] = kept; // drop emptied event keys
      }
      const next: CopilotConfig = { ...config };
      if (Object.keys(hooks).length > 0) next.hooks = hooks;
      else delete next.hooks;
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      if (serialized === before) return { removed: [] };
      backupConfig(hooksPath);
      atomicWriteFile(hooksPath, serialized);
      return { removed: [...removed] };
    },
  };
}
