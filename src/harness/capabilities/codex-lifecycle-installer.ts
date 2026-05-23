/**
 * Codex CLI lifecycle installer (#67).
 *
 * Codex hooks are NOT in a settings.json — they live in `~/.codex/config.toml`
 * under a `[hooks]` table, expressed as `[[hooks.<Event>]]` matcher-group arrays
 * (the same logical shape as Claude's `hooks.<Event>[]`, different file + format).
 *
 * We own ONLY a sentinel-delimited managed block; every other TOML key/table is
 * preserved VERBATIM. Rather than round-tripping the whole file through a TOML
 * library (which would reformat the user's dozens of `[projects.*]`/`[plugins.*]`
 * tables and the multiline `notify` array), we splice just our block: read the raw
 * text, strip any prior managed block, append a freshly rendered one. This mirrors
 * the Claude installer's safety contract (ADR-0004): symlink-refusal, backup-first,
 * atomic temp+rename. ALL newline normalization lives in ONE `normalize()` helper
 * used by both `stripManaged` and `install`, so the byte-identical idempotency
 * guarantee can't drift between strip and write.
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

const BEGIN = '# >>> agentbrainsystem hooks (managed — do not edit) >>>';
const END = '# <<< agentbrainsystem hooks (managed) <<<';

/** Codex native event → canonical moment + the `abs hook` arg the existing handler uses. */
interface CodexHookSpec {
  event: string;
  moment: LifecycleMoment;
  arg: string;
  matcher: string;
  timeout: number;
}
const CODEX_HOOKS: readonly CodexHookSpec[] = [
  { event: 'Stop', moment: 'capture', arg: 'session-end', matcher: '', timeout: 30 },
  { event: 'SessionStart', moment: 'recall', arg: 'session-start', matcher: '', timeout: 10 },
  { event: 'UserPromptSubmit', moment: 'recall', arg: 'user-prompt-submit', matcher: '', timeout: 10 },
  { event: 'PreToolUse', moment: 'guard', arg: 'pre-tool-use', matcher: '', timeout: 5 },
];

export interface CodexInstallerOptions {
  configPath?: string;
  baseCommand?: string;
  /** Trusted-project check target (W3). When set, install() reports a trustWarning if untrusted. */
  projectCwd?: string;
}

export interface CodexInstallReport extends InstallReport {
  /** W3: present when the install target cwd is NOT a trusted Codex project (hooks won't fire). */
  trustWarning?: string;
}

export interface LifecycleInstaller {
  install(): Promise<CodexInstallReport>;
  uninstall(): Promise<UninstallReport>;
}

function defaultConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

/** SINGLE source of newline normalization (C3) — both stripManaged and install use this. */
function normalize(toml: string): string {
  return toml.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * W3: best-effort trust check. Returns a warning string when the target cwd is NOT
 * a trusted Codex project (so wired hooks would silently never fire), else undefined.
 * Scans the raw TOML for the `[projects."<cwd>"]` table header, then its trust_level
 * within that block (up to the next table header).
 */
function trustWarningFor(toml: string, projectCwd: string | undefined): string | undefined {
  if (!projectCwd) return undefined;
  const header = `[projects.${JSON.stringify(projectCwd)}]`;
  const i = toml.indexOf(header);
  if (i < 0) {
    return `Codex skips managed hooks in untrusted projects — add [projects.${JSON.stringify(projectCwd)}] with trust_level = "trusted" or the hooks will never fire.`;
  }
  const nextTable = toml.indexOf('\n[', i + 1);
  const block = nextTable >= 0 ? toml.slice(i, nextTable) : toml.slice(i);
  if (/trust_level\s*=\s*"trusted"/.test(block)) return undefined;
  return `Codex skips managed hooks in untrusted projects — set trust_level = "trusted" for ${projectCwd} or the hooks will never fire.`;
}

function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`config.toml at ${path} is a symlink — refusing to write through it.`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
function backup(path: string): void {
  try {
    readFileSync(path);
  } catch {
    return;
  }
  copyFileSync(path, `${path}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
}
function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.abs-codex-tmp-${Date.now()}-${process.pid}`);
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

/** Strip an existing managed block (idempotency + uninstall). Normalizes via the SINGLE normalize(). */
function stripManaged(toml: string): string {
  const b = toml.indexOf(BEGIN);
  if (b < 0) return normalize(toml);
  const e = toml.indexOf(END, b);
  if (e < 0) return normalize(toml); // malformed — leave content as-is (just normalize), don't nuke
  const before = toml.slice(0, b);
  const after = toml.slice(e + END.length);
  return normalize(`${before}${after}`);
}

function renderBlock(baseCommand: string): string {
  const lines: string[] = [BEGIN];
  for (const h of CODEX_HOOKS) {
    lines.push(`[[hooks.${h.event}]]`, `matcher = ${JSON.stringify(h.matcher)}`);
    lines.push(
      `[[hooks.${h.event}.hooks]]`,
      'type = "command"',
      `command = ${JSON.stringify(`${baseCommand} ${h.arg}`)}`,
      `timeout = ${h.timeout}`,
    );
  }
  lines.push(END);
  return lines.join('\n');
}

const MOMENTS: LifecycleMoment[] = [...new Set(CODEX_HOOKS.map((h) => h.moment))];

export function codexLifecycleInstaller(options: CodexInstallerOptions = {}): LifecycleInstaller {
  const configPath = options.configPath ?? defaultConfigPath();
  const baseCommand = options.baseCommand ?? 'abs hook';
  return {
    install: async () => {
      assertNotSymlink(configPath);
      const raw = readText(configPath);
      const current = normalize(raw); // normalize once, compare normalized (C3)
      const trustWarning = trustWarningFor(raw, options.projectCwd); // W3
      const stripped = stripManaged(raw); // already normalized inside
      const block = renderBlock(baseCommand);
      const next =
        stripped.trim().length > 0 ? `${stripped.replace(/\n+$/, '\n')}\n${block}\n` : `${block}\n`;
      const report: CodexInstallReport = {
        wired: MOMENTS,
        ...(trustWarning ? { trustWarning } : {}),
      };
      if (next === current) return report; // true no-op: no backup, no write
      backup(configPath);
      atomicWrite(configPath, next);
      return report;
    },
    uninstall: async () => {
      assertNotSymlink(configPath);
      const raw = readText(configPath);
      if (!raw.includes(BEGIN)) return { removed: [] };
      backup(configPath);
      atomicWrite(configPath, stripManaged(raw)); // stripManaged already normalizes
      return { removed: MOMENTS };
    },
  };
}
