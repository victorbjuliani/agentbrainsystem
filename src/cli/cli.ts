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
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.js';
import { consolidate } from '../consolidate/index.js';
import { exportStore, importStore } from '../export/index.js';
import { dispatchHook, installHooks } from '../hooks/index.js';
import { defaultClaudeProjectsDir, ingestClaudeProjects } from '../ingest/index.js';
import { createLlmProvider } from '../llm/index.js';
import { startStdio } from '../mcp/index.js';
import { openMemory } from '../memory.js';
import {
  type ApplyOptions,
  applyApprovedCandidate,
  generateOptimizations,
  type OptimizeCandidate,
} from '../optimize/index.js';
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
  consolidate [opts]    Distill a session into durable lessons/decisions via an LLM.
                        Options: --session N (default: newest un-consolidated),
                        --dry-run (1 LLM call, preview only, writes nothing),
                        --force (re-consolidate, replacing prior output).
                        Requires ABS_LLM_BASE_URL + ABS_LLM_MODEL.
  install-hooks         Register the Claude Code memory hooks in ~/.claude/settings.json
                        (opt-in, idempotent, backup-first). Adds SessionEnd (auto-ingest),
                        SessionStart (baseline + staleness), UserPromptSubmit (FTS recall).
  hook <event>          Internal: run a lifecycle hook (what install-hooks registers).
                        event ∈ session-end | session-start | user-prompt-submit.
                        Reads the hook payload on stdin; non-fatal (always exits 0).
  optimize [opts]       Turn distilled memory into evidence-backed diffs for this
                        project's CLAUDE.md / Claude Code auto-memory.
                        Options: --project PATH (default: cwd), --limit N,
                        --apply (review + write per-candidate, backup/atomic/rollback),
                        --candidate ID (apply only that one), --yes (apply all, no prompt).
                        Default is preview-only — nothing is written without --apply.

Options:
  -h, --help            Show this help.
  -v, --version         Show version.

Env: ABS_HOME, ABS_DB_PATH, ABS_EMBED_PROVIDER, ABS_EMBED_MODEL, ABS_EMBED_DIM.
     ABS_LLM_BASE_URL, ABS_LLM_MODEL, ABS_LLM_API_KEY, ABS_LLM_TIMEOUT_MS, ABS_LLM_PRICE_PER_1K (consolidate).`;

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

async function cmdConsolidate(args: string[]): Promise<void> {
  const rawSession = optionValue(args, '--session');
  let sessionId: number | undefined;
  if (rawSession !== undefined) {
    const n = Number.parseInt(rawSession, 10);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`--session must be a positive integer (got '${rawSession}')`);
    }
    sessionId = n;
  }
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  const config = loadConfig();
  // Throws an actionable error if no LLM endpoint is configured — propagates to main().
  const llm = createLlmProvider(config.llm);
  const memory = await openMemory(config, { ensure: false });
  try {
    const result = await consolidate(memory, llm, {
      ...(sessionId !== undefined ? { sessionId } : {}),
      dryRun,
      force,
      ...(config.llm?.pricePer1k !== undefined ? { pricePer1k: config.llm.pricePer1k } : {}),
    });

    if (result.skipped) {
      const reason =
        result.skipped === 'already-consolidated'
          ? `session ${result.sessionId} is already consolidated (use --force to redo)`
          : result.skipped === 'no-observations'
            ? `session ${result.sessionId} has no distillable observations`
            : 'no un-consolidated session to process';
      out(`skipped: ${reason}`);
      return;
    }

    const verb = result.dryRun ? 'would write' : 'wrote';
    out(`session ${result.sessionId} — ${verb} ${result.candidates.length} lesson(s):`);
    for (const c of result.candidates) {
      out(`  [${c.kind}] ${c.content}`);
    }

    const e = result.estimate;
    const parts = [`prompt ~${e.promptCharEstimateTokens} tokens (estimate)`];
    if (e.usage) {
      parts.push(
        `actual prompt=${e.usage.promptTokens ?? '?'} completion=${e.usage.completionTokens ?? '?'}`,
      );
    }
    if (e.costEstimate !== undefined) {
      parts.push(`cost ~$${e.costEstimate.toFixed(6)}`);
    }
    out(parts.join(' | '));
    if (result.dryRun) out('(dry-run — nothing was written)');
  } finally {
    memory.close();
  }
}

/**
 * `abs hook <event>` — dispatched by the registered Claude Code hooks. Reads the
 * payload on stdin and runs the matching handler behind the non-fatal/timeout
 * contract (ADR-0004): it ALWAYS exits 0 so a session is never blocked. stdout is
 * reserved for the hook protocol (a context-injection JSON line, when applicable).
 */
async function cmdHook(args: string[]): Promise<void> {
  const event = positional(args);
  if (!event) {
    // No event arg: stay non-fatal — emit nothing, exit 0.
    return;
  }
  await dispatchHook(event);
}

/** `abs install-hooks` — register the memory hooks in settings.json (opt-in). */
async function cmdInstallHooks(): Promise<void> {
  const result = installHooks();
  if (result.added.length > 0) {
    out(`registered hooks: ${result.added.join(', ')} → ${result.settingsPath}`);
    if (result.backupPath) out(`backup: ${result.backupPath}`);
  }
  if (result.alreadyPresent.length > 0) {
    out(`already present (no change): ${result.alreadyPresent.join(', ')}`);
  }
  if (result.added.length === 0 && result.alreadyPresent.length === 0) {
    out('no hooks to register');
  }
}

/** Print one candidate (header + rationale + evidence + indented diff) to stdout. */
function printCandidate(c: OptimizeCandidate): void {
  out(`[${c.priority}] ${c.id} → ${c.target.kind}: ${c.target.absPath}`);
  out(`  ${c.title}`);
  out(`  rationale: ${c.rationale}`);
  out(`  evidence: obs ${c.evidenceIds.join(', ') || '(none)'}`);
  out(
    c.diff
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  );
  out('');
}

/**
 * `abs optimize` — the on-demand surface for the optimize loop (#21). Generates
 * evidence-backed candidate diffs through the shared converge core
 * (`generateOptimizations`), prints them, and — only with `--apply` — writes the
 * approved ones through the gated applier (`applyApprovedCandidate`: allowlist +
 * fail-closed user|feedback guard + backup/atomic/rollback, and it advances the
 * staleness cursor on a real write). Default is preview-only: nothing is written
 * without `--apply`. Approval is per-candidate (interactive y/N) unless `--yes`.
 */
async function cmdOptimize(args: string[]): Promise<void> {
  const projectRoot = optionValue(args, '--project') ?? process.cwd();
  const rawLimit = optionValue(args, '--limit');
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    const n = Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`--limit must be a positive integer (got '${rawLimit}')`);
    }
    limit = n;
  }
  const doApply = args.includes('--apply');
  const yes = args.includes('--yes');
  const onlyId = optionValue(args, '--candidate');

  const config = loadConfig();
  // ensure:false — generation reads observations and (optionally) phrases via the
  // LLM; it never embeds, so there is no reason to load the embedding model.
  const memory = await openMemory(config, { ensure: false });
  try {
    const { candidates, estimate } = await generateOptimizations(memory, config, {
      projectRoot,
      ...(limit !== undefined ? { limit } : {}),
    });

    if (candidates.length === 0) {
      out('no candidates — memory has nothing new to distill into CLAUDE.md / auto-memory.');
      return;
    }

    out(
      `${candidates.length} candidate(s) ${estimate.llmUsed ? '(LLM-phrased)' : '(heuristic, $0)'}:`,
    );
    out('');
    for (const c of candidates) printCandidate(c);

    if (!doApply) {
      out('(preview — nothing written. Re-run with --apply to review and write per-candidate.)');
      return;
    }

    const selected = onlyId ? candidates.filter((c) => c.id === onlyId) : candidates;
    if (onlyId && selected.length === 0) throw new Error(`no candidate with id '${onlyId}'`);

    const applyOptions: ApplyOptions = { projectRoot, projectsDir: defaultClaudeProjectsDir() };
    // readline prompts go to stderr so stdout stays clean for result lines.
    const rl = yes ? null : createInterface({ input: process.stdin, output: process.stderr });
    try {
      for (const c of selected) {
        if (rl) {
          const ans = (await rl.question(`apply ${c.id} → ${c.target.absPath}? [y/N] `))
            .trim()
            .toLowerCase();
          if (ans !== 'y' && ans !== 'yes') {
            out(`  ${c.id}: skipped`);
            continue;
          }
        }
        const result = await applyApprovedCandidate(memory, c, applyOptions);
        if (result.applied) {
          out(`  ${c.id}: applied → ${result.absPath} (backup ${result.backupPath})`);
        } else {
          out(`  ${c.id}: refused (${result.refused}) — nothing written`);
        }
      }
    } finally {
      rl?.close();
    }
  } finally {
    memory.close();
  }
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
    case 'consolidate':
      return cmdConsolidate(rest);
    case 'hook':
      return cmdHook(rest);
    case 'install-hooks':
      return cmdInstallHooks();
    case 'optimize':
      return cmdOptimize(rest);
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
