/**
 * OpenCode plugin-event installer (#72, Task 3 + Task 5 MCP).
 *
 * OpenCode has NO shell hooks — capture/recall fire INSIDE opencode's own Bun
 * process via an in-process plugin module exporting `Hooks`. So this installer
 * WRITES a hand-authored `.js` plugin file into `~/.config/opencode/plugin/` and
 * registers it in the resolved opencode config's `plugin[]` array. It ALSO owns the
 * file-only MCP registrar (`fileMcpRegister`), because both edits touch the SAME
 * config file and share ONE JSONC-aware `editOpencodeConfig` helper.
 *
 * C1 — config is JSONC, abort-not-clobber. OpenCode resolves config in the order
 * `opencode.jsonc → opencode.json → config.json` (verified in the 1.15.10 binary)
 * and parses ANY of them as JSONC (comments + trailing commas legal). A user's
 * `opencode.json` may therefore legally contain `// comments`, and `JSON.parse`
 * THROWS on it. The Gemini "malformed → start fresh ({})" rule would CLOBBER such a
 * config. Instead `editOpencodeConfig` strict-`JSON.parse`es the happy path and, on
 * a JSONC parse failure, ABORTS to a printed manual-merge snippet leaving the file
 * BYTE-FOR-BYTE unchanged. (Dep-free v1; a future task may add `jsonc-parser` to
 * upgrade abort→auto-edit — only the parse-FAIL branch would change.)
 *
 * C2 — the plugin bakes the ABSOLUTE `node <cli.js>` invocation, NOT bare `abs`. The
 * plugin runs in opencode's Bun process whose PATH may lack the npm-global bin; a
 * bare `abs` + the mandatory `.nothrow()` would silently swallow a PATH miss →
 * capture+recall dead. The ONLY correct source of the absolute `cli.js` path is the
 * CLI entrypoint's own `fileURLToPath(import.meta.url)`, threaded into
 * `install(cliPath)` (deriving it from THIS module's `import.meta.url` would, after
 * `tsc`, resolve to `dist/harness/capabilities/...js`, a module with no CLI
 * dispatcher — equally dead). Both `process.execPath` and the threaded `cliPath` are
 * `JSON.stringify`'d into string literals in the emitted module.
 *
 * Wnew — collision-proof backup filename. `cmdSetup` runs `registerMcp` THEN
 * `install`, two `editOpencodeConfig` edits against the SAME file in one run. The
 * Gemini ISO-millisecond `.bak` name would collide on a same-ms second edit and
 * overwrite the FIRST backup (the one holding the user's true original). This
 * module's backup helper appends `${process.pid}-${counter++}` so same-ms backups
 * get distinct names. (The gemini-lifecycle-installer helper is NOT touched.)
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { InstallReport, McpRegisterStatus, UninstallReport } from '../types.js';

export const MCP_KEY = 'agentbrainsystem';

/**
 * Extends {@link InstallReport} with the JSONC-abort manual-merge surface (C1). When
 * the config could not be edited losslessly, `manual` carries the paste snippet and
 * `targetPath` the untouched file — the CLI prints both (mirroring how the Codex
 * installer surfaces `trustWarning`). Absent on the happy path.
 */
export interface OpencodeInstallReport extends InstallReport {
  manual?: string;
  targetPath?: string;
}

export interface OpencodePluginInstallerOptions {
  /** opencode config dir (default ~/.config/opencode). */
  configDir?: string;
  /** Plugin file name written under <configDir>/plugin/ (default agentbrainsystem.js). */
  pluginFileName?: string;
  /** node binary baked into the plugin (default process.execPath). */
  nodePath?: string;
  /**
   * Test seam: a single command token that REPLACES the `${nodePath} ${cliPath}`
   * pair in the emitted plugin (so a test can inject a fake `abs`). The shipped
   * default is undefined → the absolute `node <cliPath>` pair (NEVER bare `abs`).
   */
  absCommand?: string;
}

export interface OpencodePluginInstaller {
  install(cliPath: string): Promise<OpencodeInstallReport>;
  uninstall(): Promise<UninstallReport>;
  registerMcp(cliPath: string): Promise<McpRegisterStatus>;
}

// --- module-scoped backup discriminator (Wnew: distinct same-ms backup names) ---
let backupCounter = 0;

// ----------------------------------------------------------- safety helpers
function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`config at ${path} is a symlink — refusing to write through it.`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

function backupConfig(path: string): void {
  try {
    readFileSync(path);
  } catch {
    return; // nothing to back up
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(path, `${path}.${stamp}.${process.pid}-${backupCounter++}.bak`);
}

function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.abs-opencode-tmp-${Date.now()}-${process.pid}`);
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    throw e;
  }
}

// ----------------------------------------------------------- config write strategy
const CONFIG_CANDIDATES = ['opencode.jsonc', 'opencode.json', 'config.json'] as const;

/** Resolve the config file to read/write, matching opencode's precedence (C1). */
function resolveConfigTarget(configDir: string): string {
  for (const name of CONFIG_CANDIDATES) {
    const p = join(configDir, name);
    if (existsSync(p)) return p;
  }
  // None exist → create plain JSON (we only ever write strict JSON).
  return join(configDir, 'opencode.json');
}

type OpencodeConfig = Record<string, unknown>;

/** Outcome of an `editOpencodeConfig` mutation. */
type EditResult =
  | { status: 'written'; targetPath: string }
  | { status: 'noop'; targetPath: string }
  | { status: 'manual'; targetPath: string };

/**
 * Read+mutate+write the resolved opencode config, JSONC-safe (C1):
 *   - empty/absent → start from {} (nothing to lose);
 *   - non-empty, strict JSON.parse SUCCEEDS → run mutate, backup-first + atomic write
 *     (no-op detected by byte-equality → no backup, no write);
 *   - non-empty, parse FAILS (JSONC) → DO NOT WRITE. Backup defensively, return
 *     'manual' (the caller prints the paste snippet); file left byte-unchanged.
 */
function editOpencodeConfig(
  configDir: string,
  mutate: (config: OpencodeConfig) => void,
): EditResult {
  const targetPath = resolveConfigTarget(configDir);
  assertNotSymlink(targetPath);

  let before: string | undefined;
  try {
    before = readFileSync(targetPath, 'utf8');
  } catch {
    before = undefined;
  }

  const trimmed = before?.trim() ?? '';
  let config: OpencodeConfig;
  if (trimmed.length === 0) {
    config = {};
  } else {
    try {
      const parsed = JSON.parse(before as string);
      config = typeof parsed === 'object' && parsed !== null ? (parsed as OpencodeConfig) : {};
    } catch {
      // JSONC (comments / trailing commas) — abort, never clobber.
      backupConfig(targetPath);
      return { status: 'manual', targetPath };
    }
  }

  mutate(config);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (serialized === before) return { status: 'noop', targetPath };
  backupConfig(targetPath);
  atomicWriteFile(targetPath, serialized);
  return { status: 'written', targetPath };
}

// ----------------------------------------------------------- plugin file template
/**
 * The plugin module body, written verbatim into the plugin file. It is a
 * hand-authored ESM module (NOT compiled from TS — it runs in opencode's Bun
 * runtime, not ours). `__NODE__` / `__CLI__` are substituted with JSON-stringified
 * string literals at install time; when a test passes `absCommand`, the single token
 * replaces the `${NODE} ${CLI}` pair.
 */
function renderPlugin(nodeLiteral: string, cliLiteral: string, absCommand?: string): string {
  // The shell-out prefix that precedes `opencode-capture`/`opencode-recall`.
  // Default: the absolute `${NODE} ${CLI}` pair (C2). Test: a single injected token.
  const capturePrefix = absCommand
    ? `$\`${absCommand} opencode-capture --session \${id}\``
    : // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted verbatim into the Bun plugin; ${NODE}/${CLI}/${id} are interpolated by opencode's `$` at runtime, not here.
      '$`${NODE} ${CLI} opencode-capture --session ${id}`';
  const recallPrefix = absCommand
    ? `$\`${absCommand} opencode-recall --session \${input.sessionID} --cwd \${directory}\``
    : // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted verbatim into the Bun plugin; interpolated by opencode's `$` at runtime, not here.
      '$`${NODE} ${CLI} opencode-recall --session ${input.sessionID} --cwd ${directory}`';
  const nodeDecl = absCommand ? '' : `  const NODE = ${nodeLiteral};\n`;
  const cliDecl = absCommand ? '' : `  const CLI = ${cliLiteral};\n`;
  return `// agentbrainsystem — OpenCode capture + recall bridge (managed by \`abs\`; do not edit).
// Capture: on session.idle, ingest the session from opencode.db into abs memory.
// Recall : on system-prompt transform, inject abs-recalled memory into the system array.
// CONSENT: opencode never calls \`abs hook\`, so the user is told their sessions are
//   being captured INSIDE the recall block — the abs CLI prepends a one-time memory
//   notice on the first recall of each session. Opt out with
//   \`abs project --session opencode:<id> --skip\` (run from the session's project dir).
// Absolute invocation: the plugin runs in opencode's Bun process whose PATH may lack
//   the npm-global bin, so it shells the ABSOLUTE \`node <cli.js>\` pair baked at
//   install time (NOT bare \`abs\`) — otherwise .nothrow() would silently swallow a
//   PATH miss and capture/recall would be dead.
// Staleness: re-run \`abs setup --harness opencode\` if the node binary moves
//   (the absolute paths below are baked once at install time).
// Tested against opencode 1.15.x (plugin API 1.14.24; experimental.* surface).
// Fail-open: every shell-out is .nothrow() so a non-zero \`abs\` exit never blocks opencode.
export const AbsPlugin = async ({ $, directory }) => {
  const deleted = new Set();
  const lastCap = new Map(); // sessionID → last capture epoch ms (debounce)
${nodeDecl}${cliDecl}  return {
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        deleted.add(event.properties.info.id);
        return;
      }
      if (event.type === "session.idle" || event.type === "session.compacted") {
        const id = event.properties.sessionID;
        if (deleted.has(id)) return; // GUARD: never ingest a tombstoned session
        const now = Date.now(); // debounce an idle storm: skip if <10s since last capture
        if (now - (lastCap.get(id) ?? 0) < 10000) return;
        lastCap.set(id, now);
        await ${capturePrefix}.nothrow().quiet();
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const text = await ${recallPrefix}.nothrow().quiet().text();
      const block = text.trim();
      if (block) output.system.push(block); // RECALL inject (mutable system[])
    },
  };
};
export default AbsPlugin;
`;
}

// ----------------------------------------------------------- the installer
function defaultConfigDir(): string {
  return join(homedir(), '.config', 'opencode');
}

export function opencodePluginInstaller(
  options: OpencodePluginInstallerOptions = {},
): OpencodePluginInstaller {
  const configDir = options.configDir ?? defaultConfigDir();
  const pluginFileName = options.pluginFileName ?? 'agentbrainsystem.js';
  const nodePath = options.nodePath ?? process.execPath;
  const pluginRelSpec = `./plugin/${pluginFileName}`;
  const pluginAbsPath = join(configDir, 'plugin', pluginFileName);

  /** The exact mcp entry we write (also the idempotency / collision check). */
  function mcpEntryFor(cliPath: string): Record<string, unknown> {
    return { type: 'local', command: ['node', cliPath, 'start'], enabled: true };
  }

  /** Snippet printed on a JSONC abort so the user can paste it manually. */
  function manualSnippet(cliPath: string): string {
    const mcp = {
      mcp: { [MCP_KEY]: mcpEntryFor(cliPath) },
      plugin: [pluginRelSpec],
    };
    return JSON.stringify(mcp, null, 2);
  }

  /** What to delete by hand when a JSONC config aborts the uninstall edit (#89). */
  function manualRemoveSnippet(): string {
    return `remove "${pluginRelSpec}" from the plugin[] array and the "${MCP_KEY}" key from the mcp{} object`;
  }

  return {
    async install(cliPath: string): Promise<OpencodeInstallReport> {
      const report: OpencodeInstallReport = { wired: ['capture', 'recall'] };
      // 1) Write the plugin file (absolute node <cli.js> baked in, C2).
      assertNotSymlink(pluginAbsPath);
      const body = renderPlugin(
        JSON.stringify(nodePath),
        JSON.stringify(cliPath),
        options.absCommand,
      );
      let pluginBefore: string | undefined;
      try {
        pluginBefore = readFileSync(pluginAbsPath, 'utf8');
      } catch {
        pluginBefore = undefined;
      }
      if (body !== pluginBefore) {
        mkdirSync(dirname(pluginAbsPath), { recursive: true });
        atomicWriteFile(pluginAbsPath, body);
      }
      // 2) Register the plugin in the resolved config's plugin[] (JSONC-safe).
      const result = editOpencodeConfig(configDir, (config) => {
        const arr = Array.isArray(config.plugin) ? (config.plugin as unknown[]) : [];
        if (!arr.includes(pluginRelSpec)) arr.push(pluginRelSpec);
        config.plugin = arr;
      });
      if (result.status === 'manual') {
        return { ...report, manual: manualSnippet(cliPath), targetPath: result.targetPath };
      }
      return report;
    },

    async uninstall(): Promise<UninstallReport> {
      // Remove BOTH our plugin-array entry AND our mcp.agentbrainsystem key in ONE
      // JSONC-safe edit (opencode MCP is file-managed — `opencode mcp` has no
      // non-interactive remove, so cmdUninstall's CLI unregister can't reverse it;
      // we own the reversal here). Drop a key/array if it becomes empty; leave the
      // user's other plugins + MCP servers untouched. A JSONC config aborts (no edit).
      const result = editOpencodeConfig(configDir, (config) => {
        if (Array.isArray(config.plugin)) {
          const kept = (config.plugin as unknown[]).filter((p) => p !== pluginRelSpec);
          if (kept.length > 0) config.plugin = kept;
          else delete config.plugin;
        }
        if (typeof config.mcp === 'object' && config.mcp !== null) {
          const mcp = config.mcp as Record<string, unknown>;
          // Only remove OUR entry (match by the exact node <cli.js> command shape is
          // overkill — the key is ours by name; a foreign server would not use it).
          if (MCP_KEY in mcp) delete mcp[MCP_KEY];
          if (Object.keys(mcp).length > 0) config.mcp = mcp;
          else delete config.mcp;
        }
      });
      // JSONC abort: the config edit did NOT happen, so the plugin[] entry + mcp key
      // are STILL present. Do NOT delete the plugin file (config still references it)
      // and do NOT claim removal — surface a manual snippet instead (#89).
      if (result.status === 'manual') {
        return { removed: [], manual: manualRemoveSnippet(), targetPath: result.targetPath };
      }
      // Delete the plugin file (only ours, matched by path).
      try {
        if (existsSync(pluginAbsPath) && !lstatSync(pluginAbsPath).isSymbolicLink()) {
          unlinkSync(pluginAbsPath);
        }
      } catch {
        /* best-effort */
      }
      return { removed: ['capture', 'recall'] };
    },

    async registerMcp(cliPath: string): Promise<McpRegisterStatus> {
      const entry = mcpEntryFor(cliPath);
      let alreadyIdentical = false;
      try {
        const result = editOpencodeConfig(configDir, (config) => {
          const mcp =
            typeof config.mcp === 'object' && config.mcp !== null
              ? (config.mcp as Record<string, unknown>)
              : {};
          const existing = mcp[MCP_KEY];
          if (existing !== undefined) {
            // Identical → no change. A FOREIGN server owns the key → leave it (never clobber).
            alreadyIdentical = JSON.stringify(existing) === JSON.stringify(entry);
            config.mcp = mcp; // ensure the (unchanged) object round-trips
            return;
          }
          mcp[MCP_KEY] = entry;
          config.mcp = mcp;
        });
        if (result.status === 'manual') {
          return {
            status: 'error',
            message:
              'opencode config is JSONC (comments / trailing commas) — cannot safely edit; ' +
              'add the MCP entry manually.',
            manualCommand: JSON.stringify({ mcp: { [MCP_KEY]: entry } }, null, 2),
          };
        }
        if (result.status === 'noop') return { status: 'already' };
        return { status: 'registered' };
      } catch (e) {
        if (alreadyIdentical) return { status: 'already' };
        return {
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
          manualCommand: JSON.stringify({ mcp: { [MCP_KEY]: entry } }, null, 2),
        };
      }
    },
  };
}
