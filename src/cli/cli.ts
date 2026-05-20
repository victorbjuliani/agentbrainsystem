#!/usr/bin/env node
/**
 * `abs` — agentbrainsystem CLI (issue #9).
 *
 * Commands: start (MCP stdio server), ingest, status, export, import, ui.
 * Thin layer over the library: it wires `openMemory` and the feature modules,
 * keeping all logic in src/. `start` must stay silent on stdout — that channel
 * is the MCP JSON-RPC transport; diagnostics go to stderr.
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { loadConfig } from '../config.js';
import { exportStore, importStore } from '../export/index.js';
import { ingestClaudeProjects } from '../ingest/index.js';
import { startStdio } from '../mcp/index.js';
import { openMemory } from '../memory.js';
import { startUiServer } from '../ui/index.js';
import { VERSION } from '../version.js';

const USAGE = `agentbrainsystem (abs) v${VERSION} — local-first memory for AI coding agents

Usage: abs <command> [options]

Commands:
  start                 Run the MCP server over stdio (what Claude Code spawns).
  ingest [--dir PATH]   Ingest Claude Code JSONL transcripts (default: ~/.claude/projects).
  status                Show real health: db path, schema, counts, index staleness.
  export <path>         Export the whole store to a portable artifact.
  import <path>         Import an artifact. Options: --mode replace|merge (default merge).
  ui [--port N]         Open the local read-only memory graph (127.0.0.1, default port 7717).

Options:
  -h, --help            Show this help.
  -v, --version         Show version.

Env: ABS_HOME, ABS_DB_PATH, ABS_EMBED_PROVIDER, ABS_EMBED_MODEL, ABS_EMBED_DIM.`;

/** Log to stderr so stdout stays clean for the MCP transport. */
function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function out(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

async function cmdStart(): Promise<void> {
  // No stdout writes here — startStdio owns stdout for JSON-RPC.
  await startStdio();
}

async function cmdIngest(args: string[]): Promise<void> {
  const dir = optionValue(args, '--dir');
  const memory = await openMemory();
  try {
    const result = await ingestClaudeProjects(memory, dir ? { projectsDir: dir } : {});
    out(JSON.stringify(result, null, 2));
  } finally {
    memory.close();
  }
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const memory = await openMemory(config);
  try {
    const status = memory.indexer.status();
    out(
      JSON.stringify(
        {
          version: VERSION,
          dbPath: config.dbPath,
          schemaVersion: memory.store.schemaVersion(),
          embedding: config.embedding,
          counts: memory.store.counts(),
          index: {
            stale: status.stale,
            signature: status.signature,
            startupRebuilt: memory.ensure?.rebuilt ?? false,
            startupReason: memory.ensure?.reason,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    memory.close();
  }
}

async function cmdExport(args: string[]): Promise<void> {
  const path = positional(args);
  if (!path) throw new Error('export requires a target path: abs export <path>');
  const memory = await openMemory();
  try {
    const result = await exportStore(memory.store, path);
    out(`exported ${result.observations} observations / ${result.sessions} sessions → ${path}`);
  } finally {
    memory.close();
  }
}

async function cmdImport(args: string[]): Promise<void> {
  const path = positional(args);
  if (!path) throw new Error('import requires a source path: abs import <path>');
  const mode = (optionValue(args, '--mode') ?? 'merge') as 'merge' | 'replace';
  if (mode !== 'merge' && mode !== 'replace') {
    throw new Error(`--mode must be 'merge' or 'replace' (got '${mode}')`);
  }
  const memory = await openMemory();
  try {
    const result = await importStore(memory.store, path, { mode });
    out(
      `imported ${result.observationsImported} observations / ${result.sessionsImported} sessions (${mode})`,
    );
  } finally {
    memory.close();
  }
}

/** Best-effort, non-fatal cross-platform browser open. Never throws. */
function openBrowser(url: string): void {
  try {
    const os = platform();
    const cmd = os === 'darwin' ? 'open' : os === 'win32' ? 'cmd' : 'xdg-open';
    const cmdArgs = os === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true, shell: false });
    child.on('error', () => {}); // swallow ENOENT etc. — opening is best-effort
    child.unref();
  } catch {
    // ignore — the URL is printed to stdout regardless
  }
}

async function cmdUi(args: string[]): Promise<void> {
  const rawPort = optionValue(args, '--port');
  let port: number | undefined;
  if (rawPort !== undefined) {
    const n = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      throw new Error(`--port must be an integer in 1024..65535 (got '${rawPort}')`);
    }
    port = n;
  }

  // ensure:false — the UI is a read-only viewer; it must not trigger a model load.
  const memory = await openMemory(loadConfig(), { ensure: false });
  const { server, url } = await startUiServer(memory, port !== undefined ? { port } : {});
  out(url);
  openBrowser(url);

  const shutdown = (): void => {
    server.close();
    memory.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Server keeps the event loop alive; nothing further to await.
}

/** Read the value following a `--flag` token. */
function optionValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** First non-flag token. */
function positional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('-'));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    out(USAGE);
    return;
  }
  if (command === '-v' || command === '--version') {
    out(VERSION);
    return;
  }

  switch (command) {
    case 'start':
    case 'mcp':
      return cmdStart();
    case 'ingest':
      return cmdIngest(rest);
    case 'status':
      return cmdStatus();
    case 'export':
      return cmdExport(rest);
    case 'import':
      return cmdImport(rest);
    case 'ui':
      return cmdUi(rest);
    default:
      err(`unknown command '${command}'\n`);
      err(USAGE);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  err(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
