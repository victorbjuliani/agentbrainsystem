#!/usr/bin/env node
/**
 * `abs` — agentbrainsystem CLI (issue #9).
 *
 * Commands: start (MCP stdio server), ingest, status, export, import, ui, forget.
 * Thin layer over the library: it wires `openMemory` and the feature modules,
 * keeping all logic in src/. `start` must stay silent on stdout — that channel
 * is the MCP JSON-RPC transport; diagnostics go to stderr.
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { platform } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { consolidate } from '../consolidate/index.js';
import { type DeleteSelector, executeIds, previewSelector } from '../delete/index.js';
import { EmbeddingLoadTimeoutError } from '../embedding/index.js';
import { exportStore, importStore } from '../export/index.js';
import { GLOBAL_PROJECT, getOrCreateGlobalSession, promoteAction } from '../global.js';
import type { OpencodeInstallReport } from '../harness/capabilities/opencode-plugin-installer.js';
import { sqliteTranscriptSource } from '../harness/capabilities/sqlite-transcript-source.js';
import { defaultRegistry, type HarnessAdapter } from '../harness/index.js';
import { dispatchHook } from '../hooks/index.js';
import { renderNotice } from '../hooks/session-start.js';
import {
  consumeFirstPromptFlag,
  fenceHeader,
  renderRecallBlock,
  TOP_K,
} from '../hooks/user-prompt-submit.js';
import {
  defaultClaudeProjectsDir,
  ingestClaudeProjects,
  readBinding,
  type SessionBinding,
  sanitizeProjectName,
  surveyClaudeProjects,
  writeBinding,
} from '../ingest/index.js';
import { createLlmProvider } from '../llm/index.js';
import { runMaintainAuto } from '../maintain/index.js';
import { type PostCaptureDeps, runPostCaptureMaintenance } from '../maintenance/index.js';
import { startStdio } from '../mcp/index.js';
import { type Memory, openMemory } from '../memory.js';
import {
  type ApplyOptions,
  advanceOptimizeCursorsAfterApply,
  applyApprovedCandidate,
  generateOptimizations,
  type OptimizeCandidate,
} from '../optimize/index.js';
import { projectSlug } from '../optimize/targets.js';
import { type RecallHit, resolveRecallProject } from '../recall/index.js';
import { EMBED_DEGRADED_KEY, isRebuildLocked, REBUILD_FAILED_KEY } from '../store/index.js';
import { startUiServer } from '../ui/index.js';
import { VERSION } from '../version.js';
import { MCP_SERVER_NAME, type RunFn, type RunResult, unregisterMcpServer } from './setup.js';
import { fetchLatestVersion, isOutdated } from './update-check.js';

const USAGE = `agentbrainsystem (abs) v${VERSION} — local-first memory for AI coding agents

Usage: abs <command> [options]

Commands:
  setup                 One-shot onboarding: install the hooks AND register the MCP
                        server with Claude Code. Idempotent; non-fatal if the claude
                        CLI is missing (prints the manual command instead).
  uninstall [--purge]   Reverse of setup: remove the hooks from ~/.claude/settings.json
                        AND unregister the MCP server. Idempotent; backup-first.
                        Your memory store is PRESERVED unless --purge (then it is
                        hard-deleted — IRREVERSIBLE; export first; --yes skips the
                        prompt). Prints the final 'npm uninstall -g' to run yourself.
  start                 Run the MCP server over stdio (what Claude Code spawns).
  ingest [opts]         Explicit, opt-in historical ingest of past Claude Code
                        transcripts (auto-ingest at SessionEnd covers only the current
                        session). Preview-only by default — lists projects + how much
                        is new, writes nothing. To ingest, pass --apply WITH a selector:
                        --all (every project) or --project <slug> (repeatable). Refuses
                        --apply without a selector. --dir PATH overrides the root.
  status                Show real health: db path, schema, counts, index staleness.
  doctor                Health check: integrity (quick_check), counts (observations vs
                        vectors vs FTS), embed signature, WAL size, backup path. Exits
                        non-zero on a detected problem (corrupt db / stale / drifted index).
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
  opencode-capture --session <ses> [--db PATH]
                        Internal: ingest one OpenCode session from opencode.db into
                        memory (what the OpenCode plugin shells on session.idle).
                        --db overrides the default ~/.local/share/opencode/opencode.db.
  opencode-recall --session <ses> --cwd <dir>
                        Internal: print the project-recent recall block for an OpenCode
                        session (what the OpenCode plugin injects into the system prompt).
  optimize [opts]       Turn distilled memory into evidence-backed diffs for this
                        project's CLAUDE.md / Claude Code auto-memory.
                        Options: --project PATH (default: cwd), --limit N,
                        --apply (review + write per-candidate, backup/atomic/rollback),
                        --candidate ID (apply only that one), --yes (apply all, no prompt).
                        Default is preview-only — nothing is written without --apply.
  maintain --auto       Internal: the auto-distill cadence (consolidate → auto-memory
                        only; CLAUDE.md stays manual). Spawned detached at SessionEnd
                        when a session is cadence-due; opt out with ABS_AUTO_DISTILL=0.
  forget [opts]         Selectively hard-delete memories. IRREVERSIBLE — export first
                        (abs export) before deleting. Exactly one selector:
                        --ids a,b,c (observation ids), --session N, --project NAME,
                        --null-project (sessions with no project, NOT the literal "null"),
                        --global (the cross-project global brain),
                        --search "q" [--limit N] (FTS keyword recall, no embedding).
                        Default is preview-only — nothing is deleted without --apply.
                        With --apply: per-id [y/N] confirmation (or --yes to skip prompts).
  project [opts]        Confirm/skip the CURRENT session's project (deterministic;
                        writes a decision binding applied at the next ingest). The
                        project is ALWAYS the session's folder (cwd) — no custom name.
                        No args: show resolved session, folder slug, existing projects.
                        Exactly one action: --cwd (file under the folder, reverting a
                        prior skip), --skip (exclude this session).
                        Session id: CLAUDE_CODE_SESSION_ID, or --session <id> to override.
                        --skip hard-deletes already-stored observations → requires --yes.
                        --json for machine-readable output.
  remember "<text>" --global [--kind K]
                        Add a memory to the cross-project GLOBAL brain (recalled in
                        every project). --kind decision|lesson|note (default note).
  promote <id> [--as "<text>"]
                        Promote a memory into the global brain. Without --as, MOVES
                        the whole memory. With --as, files a CURATED COPY of exactly
                        that text and KEEPS the original (promote only the reusable
                        part, leave project-specific/sensitive detail behind).

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

async function cmdStart(args: string[] = []): Promise<void> {
  // No stdout writes here — startStdio owns stdout for JSON-RPC.
  // `--harness <id>` is baked into the registered launch command (#109) so the
  // server resolves env-based sessions through the harness that launched it,
  // never a hard-coded claude-code. Absent (legacy registration) → claude-code.
  await startStdio(optionValue(args, '--harness'));
}

/**
 * `abs ingest` — EXPLICIT, opt-in historical ingest (#62). Auto-ingest at SessionEnd
 * is scoped to the current session; pulling the machine's past transcripts is this
 * deliberate command. Preview by default (lists projects + how much is new, writes
 * nothing); `--apply` ingests but REQUIRES a selector (`--all` or `--project`), so a
 * full back-fill is never accidental. `--project <slug>` is repeatable. `--dir PATH`
 * overrides the projects root (tests).
 */
export async function cmdIngest(args: string[]): Promise<void> {
  const dir = optionValue(args, '--dir');
  const all = args.includes('--all');
  const apply = args.includes('--apply');
  const projects = optionValues(args, '--project');
  const base = dir ? { projectsDir: dir } : {};

  // F6-02: `--all` (every project) and `--project <slug>` (specific) contradict each
  // other; `--all` used to silently win and drop `--project`. Refuse before any work.
  if (all && projects.length > 0) {
    err('--all and --project are mutually exclusive — pass one or the other.');
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    // Preview: survey on-disk transcripts by project. Read-only ⇒ ensure:false so we
    // never load the embedding model just to list what's available.
    const memory = await openMemory(loadConfig(), { ensure: false });
    try {
      const survey = await surveyClaudeProjects(memory, {
        ...base,
        ...(projects.length ? { projects } : {}),
      });
      if (survey.length === 0) {
        out('no transcripts found.');
        return;
      }
      out('ingest preview — transcripts on disk by project (nothing written):');
      for (const p of survey) {
        out(`  ${p.project}  ·  ${p.newTranscripts} new / ${p.transcripts} total`);
      }
      out('');
      out('Historical ingest is opt-in. To ingest, re-run with --apply and a selector:');
      out('  abs ingest --apply --all                  # every project');
      out('  abs ingest --apply --project <slug> ...    # only these projects');
    } finally {
      memory.close();
    }
    return;
  }

  // Apply requires an explicit selector so a full ingest is never accidental.
  if (!all && projects.length === 0) {
    err('refusing to ingest without a selector — pass --all or --project <slug> (repeatable).');
    err('(run `abs ingest` with no --apply to preview what is available.)');
    process.exitCode = 1;
    return;
  }

  const memory = await openMemory();
  try {
    const result = await ingestClaudeProjects(memory, {
      ...base,
      ...(all ? {} : { projects }),
    });
    out(JSON.stringify(result, null, 2));
  } finally {
    memory.close();
  }
}

/** One harness's status row for `abs status`. */
export interface HarnessStatusRow {
  id: string;
  displayName: string;
  /** Is this harness installed on the current machine? (adapter.detect) */
  installed: boolean;
  /** Does this harness expose all four parity pillars? (adapter.qualifies) */
  parity: boolean;
}

/** The minimal registry shape `gatherHarnessStatus` needs (fake-able in tests). */
interface HarnessStatusRegistry {
  all(): readonly HarnessAdapter[];
}

/**
 * Build a status row per known harness adapter. Each `detect()` is awaited
 * defensively — a throwing adapter never crashes status; it surfaces as
 * `installed: false`. `parity` reads the synchronous `qualifies()` gate.
 *
 * "wired" (is THIS harness's lifecycle actually installed) is intentionally NOT
 * reported: there is no `isInstalled` on the adapter contract, and probing it
 * would mean re-parsing five distinct config formats (settings.json / config.toml /
 * hooks.json / opencode JSONC). `installed + parity` is the concise, non-fatal
 * surface the user needs to know they can run `abs setup --harness <id>`.
 */
export async function gatherHarnessStatus(
  registry: HarnessStatusRegistry,
): Promise<HarnessStatusRow[]> {
  const adapters = registry.all();
  return Promise.all(
    adapters.map(async (a) => {
      let installed = false;
      try {
        installed = await a.detect();
      } catch {
        installed = false; // a throwing detect() must never crash status
      }
      let parity = false;
      try {
        parity = a.qualifies().ok;
      } catch {
        parity = false;
      }
      return { id: a.id, displayName: a.displayName, installed, parity };
    }),
  );
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const memory = await openMemory(config);
  try {
    const status = memory.indexer.status();
    const globalSession = memory.store.getSessionByExternalId(GLOBAL_PROJECT);
    const globalObservations = globalSession
      ? memory.store.listObservations({ sessionId: globalSession.id }).length
      : 0;
    const harnesses = await gatherHarnessStatus(defaultRegistry());
    out(
      JSON.stringify(
        {
          version: VERSION,
          dbPath: config.dbPath,
          schemaVersion: memory.store.schemaVersion(),
          embedding: config.embedding,
          counts: memory.store.counts(),
          globalObservations,
          index: {
            stale: status.stale,
            signature: status.signature,
            startupRebuilt: memory.ensure?.rebuilt ?? false,
            startupReason: memory.ensure?.reason,
          },
          harnesses,
        },
        null,
        2,
      ),
    );
  } finally {
    memory.close();
  }
}

export interface DoctorDeps {
  /** Override the version probe (tests inject this to stay hermetic/offline). */
  fetchLatest?: () => Promise<string | null>;
}

export async function cmdDoctor(deps: DoctorDeps = {}): Promise<void> {
  const fetchLatest = deps.fetchLatest ?? (() => fetchLatestVersion());
  const config = loadConfig();
  // ensure:false → report the on-disk staleness verdict instead of silently
  // healing it with a rebuild. A corrupt db throws CorruptStoreError at open
  // (caught by main → actionable message + non-zero exit) before we get here.
  const memory = await openMemory(config, { ensure: false });
  try {
    const integrity = memory.store.quickCheck();
    const counts = memory.store.counts();
    const status = memory.indexer.status();
    const drift = counts.vectors !== counts.observations || counts.fts !== counts.observations;
    // Durable degraded signals that drive the SessionStart "DEGRADED" banner. doctor opens
    // with ensure:false (no silent rebuild), so it reports the on-disk truth — and must SURFACE
    // these or it would say healthy:true while the banner says broken (the two contradicting).
    const rebuildFailedAt = memory.store.getMeta(REBUILD_FAILED_KEY);
    const embedDegradedAt = memory.store.getMeta(EMBED_DEGRADED_KEY);
    const degraded = rebuildFailedAt !== null || embedDegradedAt !== null;
    const healthy = integrity.ok && !status.stale && !drift && !degraded;
    // Best-effort, offline-safe (null on any failure). Explicit command only.
    const latest = await fetchLatest();
    const updateAvailable = latest !== null && isOutdated(VERSION, latest);
    out(
      JSON.stringify(
        {
          dbPath: config.dbPath,
          healthy,
          integrity,
          counts,
          drift,
          index: {
            stale: status.stale,
            signature: status.signature,
            expectedSignature: status.expectedSignature,
          },
          degraded: {
            rebuildFailedAt,
            embedModelTimeoutAt: embedDegradedAt,
          },
          walSizeBytes: memory.store.walSizeBytes(),
          backupPath: memory.store.backupPath(),
          version: { current: VERSION, latest, updateAvailable },
        },
        null,
        2,
      ),
    );
    if (!healthy) {
      err(
        !integrity.ok
          ? 'abs doctor: memory.db FAILED its integrity check — restore from the `.bak` next to ' +
              'the db, or your last `abs export`.'
          : degraded && !status.stale && !drift
            ? 'abs doctor: a degraded flag is set' +
              (rebuildFailedAt ? ` (rebuild failed at ${rebuildFailedAt})` : '') +
              (embedDegradedAt ? ` (embedding model load timed out at ${embedDegradedAt})` : '') +
              '. The index itself looks fresh — run `abs status` to clear it after a successful ' +
              'rebuild/embed; if it persists, recall may be degraded.'
            : 'abs doctor: index is STALE/drifted — recall is degraded. It rebuilds on the next ' +
              'MCP launch (`abs start`); run `abs status` to trigger a rebuild now.',
      );
      process.exitCode = 1;
    }
    if (updateAvailable) {
      err(
        `abs doctor: update available — you have ${VERSION}, latest is ${latest}. ` +
          'Run `npm i -g agentbrainsystem@latest && abs setup`.',
      );
    }
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

export async function cmdImport(args: string[]): Promise<void> {
  // F6-01: drop the `--mode <value>` pair so the space form (`import --mode replace
  // <path>`) can't read 'replace' as the source path.
  const path = positional(stripFlagPair(args, '--mode'));
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

  // --no-open: print the URL but don't launch a browser. The Tauri tray companion
  // (src-tauri) uses this to host the ocean in its own webview window after parsing
  // the URL from stdout — without it, `abs ui` would also pop a system browser tab.
  const noOpen = args.includes('--no-open');

  // ensure:false — the UI is a read-only viewer; it must not trigger a model load.
  const memory = await openMemory(loadConfig(), { ensure: false });
  const { server, url } = await startUiServer(memory, port !== undefined ? { port } : {});
  out(url);
  if (!noOpen) openBrowser(url);

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

/**
 * `abs opencode-capture --session <ses_…>` (#72) — the OpenCode capture entry the
 * in-process plugin shells to on `session.idle`/`session.compacted`. Ingests that
 * session from opencode.db (read-only) into memory, riding the id-anchored watermark.
 * openMemory with the default ensure gate (a drifted index self-heals, same as
 * SessionEnd). The PLUGIN is the fail-open boundary (`.nothrow()`), so a hard error
 * here cleanly exits 1 (the plugin swallows it); success is silent (plugin `.quiet()`s).
 *
 * Failure classification (#156): a swallowed `process.exitCode = 1` made "embedded 0
 * observations because the model failed" indistinguishable from "nothing to ingest"
 * success, surfacing downstream as a silent empty `<recalled-memory>` block. We now mirror
 * SessionEnd exactly: a budgeted `ensureReady` warms the model UP FRONT so a cold first-run
 * download surfaces as `EmbeddingLoadTimeoutError` instead of blocking the idle handler for
 * ~35s (an unbudgeted `indexer.write` would never time out — #176 Codex review). A timeout
 * DEFERS (degraded note + exit 0, retried next session, no data lost); any other embed/
 * persist error FAILS LOUDLY with a dedicated exit code (3) so the empty-persist is
 * unmistakable.
 */
const OPENCODE_CAPTURE_EMBED_FAIL_EXIT = 3;
// Warm the model with the same budget the SessionEnd hook uses (session-end.ts), so the
// defer path is reachable in production, not just under an injected provider.
const OPENCODE_CAPTURE_EMBED_BUDGET_MS = 6_000;

export interface OpencodeCaptureDeps extends PostCaptureDeps {
  /**
   * Injection seam for tests — override how memory is opened so a failing provider can be
   * exercised hermetically (the real model is never loaded). Defaults to the real
   * `openMemory(loadConfig())`.
   */
  openMemory?: () => Promise<Memory>;
  /**
   * Injection seam for tests — override the budgeted model warm-up so the defer path can be
   * exercised without a real cold download. Defaults to `memory.provider.ensureReady`.
   */
  embedReady?: (opts: { budgetMs?: number }) => Promise<void>;
}

export async function cmdOpencodeCapture(
  args: string[],
  deps: OpencodeCaptureDeps = {},
): Promise<void> {
  const sessionId = optionValue(args, '--session');
  if (!sessionId) {
    err('opencode-capture: --session <ses_…> is required');
    process.exitCode = 1;
    return;
  }
  const dbPath = optionValue(args, '--db'); // optional override (tests / non-default store)
  // The plugin passes the session's project dir (#107) so the post-capture anchor
  // sweep roots ground truth correctly; default to the process cwd otherwise.
  const cwd = optionValue(args, '--cwd') ?? process.cwd();
  // #159 (F1-01): mirror the SessionEnd rebuild-lock defer (session-end.ts). If a
  // background MCP rebuild holds the cross-process write lock, racing our ingest into
  // it would block on busy_timeout and then fail-open, SILENTLY losing this session.
  // Defer instead — the opencode cursor is NOT advanced, so a later capture re-pulls
  // it (no data lost). Do NOT write a kv_meta marker (#159 F2-03 removed that dead
  // state); the stderr line is the reliable defer signal.
  const { dbPath: storeDbPath } = loadConfig();
  if (isRebuildLocked(storeDbPath)) {
    err(
      'opencode-capture deferred: an index rebuild is in progress; ' +
        'this session will be re-ingested later (no data lost).',
    );
    return;
  }
  const memory = await (deps.openMemory ?? (() => openMemory(loadConfig())))();
  try {
    // #176 (Codex review): warm the model UP FRONT with a budget, exactly like SessionEnd
    // (session-end.ts). `indexer.write` calls the provider with NO budget and would block on
    // the full first-run download (~35s) rather than throw, so without this the defer branch
    // below is unreachable in the real OpenCode path. A budgeted ensureReady is the ONLY
    // path that raises `EmbeddingLoadTimeoutError`.
    const ensureReady = deps.embedReady ?? memory.provider.ensureReady?.bind(memory.provider);
    if (ensureReady) await ensureReady({ budgetMs: OPENCODE_CAPTURE_EMBED_BUDGET_MS });
    await sqliteTranscriptSource(dbPath ? { dbPath } : {}).ingestSession(memory, sessionId);
    // #107: OpenCode has no SessionEnd, so run the same claimed→verified anchor sweep
    // here that the SessionEnd handler runs for every other harness. The helper is
    // fail-open (never throws), so a sweep miss can't fail the capture. Tests inject
    // `groundTruth` so the real refreshIndex (tree-sitter wasm + repo scan) is skipped.
    await runPostCaptureMaintenance(memory.store, cwd, deps);
  } catch (e) {
    // #156: differentiate the failure classes instead of masking everything into a
    // generic exit 1 (which made a failed embed indistinguishable from "nothing to
    // ingest" success — a silent empty recall downstream).
    if (e instanceof EmbeddingLoadTimeoutError) {
      // Transient: the embedding model is still loading (first run, raised by the budgeted
      // ensureReady above). DEFER — mirror the SessionEnd hook (session-end.ts): best-effort
      // degraded note, exit 0. ingestSession never ran, so the opencode cursor is NOT
      // advanced and a later capture re-pulls this session (no data lost).
      try {
        memory.store.setMeta(EMBED_DEGRADED_KEY, new Date().toISOString());
      } catch {
        // best-effort note — the stderr line below is the reliable defer signal
      }
      err('opencode-capture deferred: embedding model still loading; will retry next session');
    } else {
      // Genuine embed/persist failure (dimension mismatch, disk, provider error, …) →
      // FAIL LOUDLY with a dedicated exit code distinguishable from the generic exit 1.
      err(
        `capture persisted 0 observations (embedding failed?): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      process.exitCode = OPENCODE_CAPTURE_EMBED_FAIL_EXIT;
    }
  } finally {
    memory.close();
  }
}

/**
 * `abs opencode-recall --session <ses_…> --cwd <dir>` (#72) — the OpenCode recall
 * entry the plugin shells to in `experimental.chat.system.transform`, reading stdout
 * into `output.system[]`. The system-transform hook has NO user prompt, so recall is
 * a PROJECT-RECENT pull (W2: `MemoryStore.listObservations({ project, order:'desc',
 * limit:TOP_K })` — a real, no-model-load indexed read), NOT prompt-scoped FTS.
 * Opened `{ ensure: false }` (read-only fast path, no model cold-load — ADR-0005).
 *
 * C3 consent: opencode never calls `abs hook`, so the SessionStart notice never
 * fires. On the FIRST recall per session we PREPEND `renderNotice` via the EXACT
 * `consumeFirstPromptFlag` machinery (keyed `opencode:<ses>`, can't collide with a
 * Claude key). Second+ recall → flag consumed → no notice.
 */
export async function cmdOpencodeRecall(args: string[]): Promise<void> {
  const sessionId = optionValue(args, '--session');
  const cwd = optionValue(args, '--cwd');
  if (!sessionId || !cwd) {
    err('opencode-recall: --session <ses_…> and --cwd <dir> are required');
    process.exitCode = 1;
    return;
  }
  const sid = `opencode:${sessionId}`;
  const memory = await openMemory(loadConfig(), { ensure: false });
  try {
    const project = resolveRecallProject(memory.store, { scope: 'project', sessionId: sid, cwd });
    const obs = memory.store.listObservations({ project, order: 'desc', limit: TOP_K });
    const hits: RecallHit[] = obs.map((observation) => ({ observation, score: 0 }));
    const recallBlock = renderRecallBlock(hits, fenceHeader(project));
    // C3: one-time consent notice on the session's first recall.
    const noticeBlock = consumeFirstPromptFlag(memory.store, sid) ? renderNotice(sid, cwd) : '';
    const combined = [noticeBlock, recallBlock].filter((b) => b.length > 0).join('\n\n');
    if (combined.length > 0) out(combined);
  } finally {
    memory.close();
  }
}

/**
 * Resolve the harness adapter(s) to act on from a `--harness <id>` flag. With the
 * flag, the named adapter must exist and `qualifies()`; otherwise we refuse with a
 * non-zero exit. With no flag, the Claude Code reference adapter is used (Phase 0;
 * cross-adapter auto-detect lands with the second adapter). Returns null after
 * printing an error + setting a non-zero exit code.
 */
export function resolveHarnesses(args: string[]): HarnessAdapter[] | null {
  // A `--harness` flag with a missing/flag-shaped value is an ERROR, not a silent
  // fall-back to the default Claude adapter (Codex review on #77): falling through
  // would run real setup (settings.json / MCP registration) on a typo like
  // `abs setup --harness`. Mirrors the `--session` strict-parse contract.
  if (hasFlag(args, '--harness')) {
    const id = optionValue(args, '--harness');
    if (id === undefined || id.startsWith('-')) {
      out('! --harness requires a harness id value');
      process.exitCode = 1;
      return null;
    }
    const adapter = defaultRegistry().byId(id);
    if (!adapter) {
      out(`! unknown harness '${id}'`);
      process.exitCode = 1;
      return null;
    }
    const q = adapter.qualifies();
    if (!q.ok) {
      out(`! harness '${id}' does not qualify (missing: ${q.missing.join(', ')})`);
      process.exitCode = 1;
      return null;
    }
    return [adapter];
  }
  // No flag → the Claude Code reference adapter (Phase 0 default).
  const claude = defaultRegistry().byId('claude-code');
  return claude ? [claude] : [];
}

/**
 * C1 (opencode): when `install()` couldn't losslessly edit a JSONC config, it returns
 * a manual-merge snippet (config left byte-unchanged). Print it so the user can paste.
 * The four shell-hook adapters never set this — it's a no-op for them.
 */
function surfaceJsoncManual(displayName: string, report: OpencodeInstallReport): void {
  if (!report.manual) return;
  out(
    `! ${displayName} config is JSONC — add this to ${report.targetPath ?? 'your config'} manually:`,
  );
  out(report.manual);
}

/** `abs install-hooks` — register the memory hooks in settings.json (opt-in). */
async function cmdInstallHooks(args: string[]): Promise<void> {
  const harnesses = resolveHarnesses(args);
  if (!harnesses) return;
  // C2: thread the CLI entrypoint path (this module's import.meta.url) into install()
  // so the OpenCode adapter can bake the absolute `node <cli.js>` into its plugin file.
  // The four shell-hook adapters accept-and-ignore it.
  const cliPath = fileURLToPath(import.meta.url);
  for (const adapter of harnesses) {
    const report = await adapter.install(cliPath);
    surfaceJsoncManual(adapter.displayName, report);
    const alreadyPresent = report.alreadyPresent ?? [];
    if (report.wired.length > 0) {
      out(`registered hooks (${adapter.displayName}): ${report.wired.join(', ')}`);
    } else if (alreadyPresent.length > 0) {
      // Idempotent re-run: nothing newly wired, every moment already present (ADR-0004).
      out(`hooks already present (${adapter.displayName}): ${alreadyPresent.join(', ')}`);
    } else {
      out(`no hooks to register (${adapter.displayName})`);
    }
    // W3 (#67): Codex silently skips config.toml-managed hooks in untrusted projects,
    // so a perfectly valid [hooks] block can never fire — surface that here.
    if ('trustWarning' in report && report.trustWarning) out(`! ${report.trustWarning}`);
  }
}

/**
 * Real `run` for `abs setup`: spawn (no shell ⇒ no command injection), capture
 * stdout/stderr, and resolve `code: null` on a spawn failure instead of throwing —
 * matching the non-fatal `RunFn` contract the setup core expects.
 */
function spawnCapture(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: null, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', () => resolve({ code: null, stdout, stderr }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * `abs setup` — one-shot onboarding: install the memory hooks AND register this CLI
 * as a stdio MCP server with Claude Code. Both steps are idempotent. A missing
 * `claude` CLI degrades to a printed manual command (non-fatal).
 */
async function cmdSetup(args: string[]): Promise<void> {
  const harnesses = resolveHarnesses(args);
  if (!harnesses) return;
  const adapter = harnesses[0];
  if (!adapter) {
    out('no harness available to set up');
    return;
  }

  // Register MCP FIRST, then install hooks (W1-warn ordering): for Codex BOTH steps
  // write the SAME config.toml — `codex mcp add` mutates [mcp_servers.*], our splice
  // writes [hooks]. Running MCP first means codex's own writer touches the file before
  // our splice reads-merges-writes, so our sentinel block is the last thing written and
  // can't be clobbered. For Claude this reorder is inert (separate files).
  const cliPath = fileURLToPath(import.meta.url);
  const reg = await adapter.registerMcp(cliPath, spawnCapture);
  switch (reg.status) {
    case 'registered':
      out(`✓ MCP server registered with ${adapter.displayName} as "${MCP_SERVER_NAME}"`);
      break;
    case 'already':
      out(`✓ MCP server already registered as "${MCP_SERVER_NAME}"`);
      break;
    case 'unavailable':
      out(`! ${adapter.mcpBinary ?? 'claude'} CLI not found — register the MCP server manually:`);
      out(`    ${reg.manualCommand}`);
      break;
    case 'error':
      out(`! Could not auto-register the MCP server (${reg.message}). Run manually:`);
      out(`    ${reg.manualCommand}`);
      break;
  }

  const hooks = await adapter.install(cliPath);
  const hooksAlreadyPresent = hooks.alreadyPresent ?? [];
  if (hooks.wired.length > 0) out(`✓ hooks registered: ${hooks.wired.join(', ')}`);
  // Idempotent re-run: `wired` is now newly-wired only, so report the already-present
  // set too — otherwise a repeat `abs setup` goes silent on hooks (reads as "not set up").
  else if (hooksAlreadyPresent.length > 0)
    out(`✓ hooks already present: ${hooksAlreadyPresent.join(', ')}`);
  // W3: surface the trust warning when wiring Codex hooks into an untrusted project.
  if ('trustWarning' in hooks && hooks.trustWarning) out(`! ${hooks.trustWarning}`);
  surfaceJsoncManual(adapter.displayName, hooks);

  out('');
  out(`Done. Restart ${adapter.displayName} — it will recall + remember automatically.`);
  out('Explore your memory anytime with:  abs ui');
}

/**
 * Hard-delete the SQLite store and its WAL/SHM sidecars. IRREVERSIBLE — prompts for
 * confirmation unless `yes`. Called only on `abs uninstall --purge`. The data dir
 * (model cache etc.) is left intact; only the user's memory store is removed.
 */
async function purgeStore(dbPath: string, yes: boolean): Promise<void> {
  const targets = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((p) => existsSync(p));
  out('');
  if (targets.length === 0) {
    out(`No memory store found at ${dbPath} — nothing to purge.`);
    return;
  }
  out('--purge will hard-delete your memory store (IRREVERSIBLE):');
  for (const t of targets) out(`  ${t}`);
  out('  export first (abs export <path>) to keep a recoverable copy.');

  if (!yes) {
    // Prompt on stderr so stdout stays clean.
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const ans = (await rl.question('delete the memory store? [y/N] ')).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        out('purge skipped — memory store kept.');
        return;
      }
    } finally {
      rl.close();
    }
  }
  for (const t of targets) rmSync(t, { force: true });
  out(`✓ memory store deleted (${targets.length} file(s)).`);
}

/**
 * `abs uninstall` — the inverse of `abs setup`. Removes our hooks from
 * settings.json and unregisters the MCP server (both idempotent, backup-first,
 * non-fatal when the claude CLI is missing). The memory store is PRESERVED unless
 * `--purge` (then it's hard-deleted, confirmed unless `--yes`). The npm package
 * itself is NOT removed here — a process can't reliably delete the binary it's
 * running from — so we print the final `npm uninstall -g` line to run afterwards.
 */
/** Injection seam for `cmdUninstall` (tests stub the MCP `run`). */
export interface UninstallDeps {
  run?: RunFn;
}

export async function cmdUninstall(args: string[], deps: UninstallDeps = {}): Promise<void> {
  const purge = args.includes('--purge');
  const yes = args.includes('--yes');
  const run = deps.run ?? spawnCapture;

  // Resolve the SELECTED harness(es) — `--harness codex` must uninstall Codex, not
  // always Claude (C2). No flag → the Claude Code default (byte-identical for
  // existing users).
  const harnesses = resolveHarnesses(args);
  if (!harnesses) return;

  for (const adapter of harnesses) {
    // 1. Remove this adapter's lifecycle wiring (TOML for codex, settings.json for claude).
    const hooks = await adapter.uninstall();
    // JSONC abort (#89): a file-managed adapter could not edit its config, so NOTHING
    // (hooks OR the MCP entry) was removed — surface what to delete by hand and skip
    // the success lines + the CLI/file MCP step, instead of falsely reporting removal.
    if (hooks.manual) {
      out(
        `! ${adapter.displayName} config is JSONC (comments / trailing commas) — could not auto-remove.`,
      );
      out(`  In ${hooks.targetPath ?? 'your config'}, ${hooks.manual}.`);
      continue;
    }
    out(
      hooks.removed.length > 0
        ? `✓ hooks removed (${adapter.displayName}): ${hooks.removed.join(', ')}`
        : `✓ no abs hooks were present (${adapter.displayName})`,
    );

    // 2. Unregister the MCP server. File-managed adapters (opencode) already removed
    // their config entry in step 1's uninstall() — `opencode mcp` has no
    // non-interactive remove, so the CLI path would hang/fail. Skip it for them.
    if (adapter.mcpFileManaged) {
      out(`✓ MCP server entry removed from ${adapter.displayName} config`);
      continue;
    }
    const binary = adapter.mcpBinary ?? 'claude';
    const reg = await unregisterMcpServer(run, {
      binary,
      argStyle: adapter.mcpArgStyle,
      scope: adapter.mcpScope,
    });
    switch (reg.status) {
      case 'removed':
        out(`✓ MCP server "${MCP_SERVER_NAME}" unregistered from ${adapter.displayName}`);
        break;
      case 'not-registered':
        out(`✓ MCP server "${MCP_SERVER_NAME}" was not registered (${adapter.displayName})`);
        break;
      case 'no-claude':
        out(`! ${binary} CLI not found — unregister the MCP server manually:`);
        out(`    ${reg.manualCommand}`);
        break;
      case 'error':
        out(`! Could not auto-unregister the MCP server (${reg.message}). Run manually:`);
        out(`    ${reg.manualCommand}`);
        break;
    }
  }

  // 3. Memory store: preserved by default, hard-deleted only with --purge.
  const config = loadConfig();
  if (purge) {
    await purgeStore(config.dbPath, yes);
  } else {
    out('');
    out(`Memory preserved at ${config.dbPath}`);
    out('  (re-run with --purge to delete it — IRREVERSIBLE; abs export first to keep a copy).');
  }

  // 4. The package itself: npm's job, not ours. Run it AFTER this command, while we
  //    still exist to do the cleanup above.
  out('');
  out('Final step — remove the program (run this yourself, after this command):');
  out('    npm uninstall -g agentbrainsystem');
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
  // The paired MEMORY.md index-pointer edit (#140), shown so it is reviewed before --apply.
  if (c.indexWrite) {
    out('  + MEMORY.md index pointer (makes the entry surface in native memory):');
    out(
      c.indexWrite.diff
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }
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
export async function cmdOptimize(args: string[]): Promise<void> {
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
    const { candidates, estimate, survivingIds } = await generateOptimizations(memory, config, {
      projectRoot,
      ...(limit !== undefined ? { limit } : {}),
    });

    // Curated-out count (#146): consolidated items dropped as low-durability (still in
    // the store, just not promoted). Surfaced so curation is observable, not a silent gate.
    const dropped = estimate.curation?.droppedCount ?? 0;
    const heldBack =
      dropped > 0
        ? ` (${dropped} item(s) held back as low-durability${estimate.curation?.judgeUsed ? ', LLM-judged' : ''})`
        : '';

    if (candidates.length === 0) {
      out(
        `no candidates — memory has nothing new to distill into CLAUDE.md / auto-memory.${heldBack}`,
      );
      // A bare preview never advances; but an --apply run over an all-curated-out set
      // MUST advance (survivors empty ⇒ pending-valid empty ⇒ #148 cursor advance), so
      // the zero-candidate path falls through to the run-level advance ONLY with --apply.
      if (doApply) {
        advanceOptimizeCursorsAfterApply(
          memory,
          projectSlug(projectRoot),
          new Set(survivingIds),
          candidates,
          new Set<string>(),
        );
      }
      return;
    }

    out(
      `${candidates.length} candidate(s) ${estimate.llmUsed ? '(LLM-phrased)' : '(heuristic, $0)'}${heldBack}:`,
    );
    out('');
    for (const c of candidates) printCandidate(c);

    if (!doApply) {
      out('(preview — nothing written. Re-run with --apply to review and write per-candidate.)');
      // Bare preview: nothing was reviewed for write, so every survivor is pending-valid
      // ⇒ no advance. Return BEFORE the run-level advance (no false "all caught up", C2).
      return;
    }

    const selected = onlyId ? candidates.filter((c) => c.id === onlyId) : candidates;
    if (onlyId && selected.length === 0) throw new Error(`no candidate with id '${onlyId}'`);

    const applyOptions: ApplyOptions = { projectRoot, projectsDir: defaultClaudeProjectsDir() };
    // Track which candidates were genuinely written so the run-level advance can derive
    // the §4 partition (promoted = ∪ evidenceIds of applied candidates of a kind).
    const appliedIds = new Set<string>();
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
          appliedIds.add(c.id);
          out(`  ${c.id}: applied → ${result.absPath} (backup ${result.backupPath})`);
          if (result.indexWarning) out(`  ${c.id}: ⚠ ${result.indexWarning}`);
        } else {
          out(`  ${c.id}: refused (${result.refused}) — nothing written`);
        }
      }
    } finally {
      rl?.close();
    }

    // Run-level advance (#138/#148 §4), AFTER the apply loop and only on --apply: the
    // SAME keep-set-driven helper the cadence runner uses, fed the un-sliced keep-set
    // (`survivingIds`). A --limit-sliced survivor stays pending-valid (no advance); a
    // skipped/declined kind stays pending-valid; an all-promoted/all-curated-out kind
    // advances. `candidates` (not `selected`) is the reviewed set when no --candidate
    // filter was given; with --candidate, non-selected survivors remain pending-valid.
    advanceOptimizeCursorsAfterApply(
      memory,
      projectSlug(projectRoot),
      new Set(survivingIds),
      candidates,
      appliedIds,
    );
  } finally {
    memory.close();
  }
}

/**
 * `abs maintain --auto` — the internal, non-interactive auto-distill cadence (#138).
 * SessionEnd spawns this detached when a session is cadence-due; it can also be run by
 * hand. Drives `consolidate → generateOptimizations → auto-apply auto-memory only`
 * behind a dedicated cadence lock, advances the kind/project optimize cursors, and
 * records token observability. `--auto` is the ONLY mode (a future interactive mode
 * would add a flag); without it we print a one-line usage and exit 0. Fail-open
 * (ADR-0004): any error is swallowed so a SessionEnd spawn never surfaces a failure.
 */
async function cmdMaintain(args: string[]): Promise<void> {
  if (!args.includes('--auto')) {
    out('usage: abs maintain --auto   (internal auto-distill cadence; spawned at SessionEnd)');
    return;
  }
  const config = loadConfig();
  // Default ensure — a drifted index self-heals here, same as the SessionEnd path.
  const memory = await openMemory(config);
  try {
    await runMaintainAuto(memory, config);
  } catch {
    // Fail-open (ADR-0004): a background cadence must never surface an error.
  } finally {
    memory.close();
  }
}

/**
 * Parse `--ids a,b,c` into a deduped list of positive observation ids. Mirrors the
 * port-validation strictness of `cmdUi`: an empty token, a non-numeric token, or an
 * id ≤ 0 is a hard, actionable error — we never silently drop a malformed id.
 */
export function parseIds(raw: string): number[] {
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const token of raw.split(',')) {
    const t = token.trim();
    if (t === '') throw new Error(`--ids has an empty entry in '${raw}'`);
    const n = Number.parseInt(t, 10);
    // Reject non-numeric ('12a' parses to 12 under parseInt) and non-positive.
    if (!Number.isInteger(n) || String(n) !== t || n <= 0) {
      throw new Error(`--ids entries must be positive integers (got '${t}')`);
    }
    if (seen.has(n)) continue; // dedupe
    seen.add(n);
    ids.push(n);
  }
  if (ids.length === 0) throw new Error('--ids requires at least one id, e.g. --ids 1,2,3');
  return ids;
}

/**
 * Resolve the `forget` argv into exactly one delete selector. The five selectors are
 * mutually exclusive: zero is an error (nothing to delete) and more than one is an
 * error (ambiguous). `--null-project` is the NULL-project selector (`byProject: null`)
 * and is deliberately distinct from `--project null`, which targets the literal
 * string `'null'`.
 */
export function parseForgetSelector(args: string[]): DeleteSelector {
  const rawIds = optionValue(args, '--ids');
  const rawSession = optionValue(args, '--session');
  const rawProject = optionValue(args, '--project');
  const nullProject = args.includes('--null-project');
  const global = args.includes('--global');
  const rawSearch = optionValue(args, '--search');

  const chosen = [
    rawIds !== undefined,
    rawSession !== undefined,
    rawProject !== undefined,
    nullProject,
    global,
    rawSearch !== undefined,
  ].filter(Boolean).length;
  if (chosen === 0) {
    throw new Error(
      'forget requires exactly one selector: --ids, --session, --project, --null-project, --global, or --search',
    );
  }
  if (chosen > 1) {
    throw new Error('forget selectors are mutually exclusive — pass exactly one');
  }

  if (rawIds !== undefined) return { byIds: parseIds(rawIds) };
  if (rawSession !== undefined) {
    const n = Number.parseInt(rawSession, 10);
    if (!Number.isInteger(n) || String(n) !== rawSession.trim() || n <= 0) {
      throw new Error(`--session must be a positive integer (got '${rawSession}')`);
    }
    return { bySession: n };
  }
  if (global) return { byProject: GLOBAL_PROJECT };
  if (rawProject !== undefined) return { byProject: rawProject };
  if (nullProject) return { byProject: null };

  // rawSearch is defined here.
  const search = rawSearch as string;
  if (search.trim() === '') throw new Error('--search requires a non-empty query');
  const rawLimit = optionValue(args, '--limit');
  if (rawLimit !== undefined) {
    const n = Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`--limit must be a positive integer (got '${rawLimit}')`);
    }
    return { bySearch: { query: search, limit: n } };
  }
  return { bySearch: { query: search } };
}

/**
 * `abs forget` — selectively hard-delete memories (Phase B1). Resolves the selector
 * to a concrete id set IN-PROCESS via `previewSelector` (no handle/cache needed — the
 * whole preview→confirm→delete loop lives here), prints what would go, and only with
 * `--apply` deletes — after a per-id [y/N] confirmation (or `--yes` to skip prompts).
 * Hard-delete is IRREVERSIBLE: there is no `.abs-bak` for deletes, so the preview and
 * USAGE point the user at `abs export` as the only recovery. `ensure:false` so a
 * `--search` preview never triggers an embedding-model cold-load (it's FTS-only).
 *
 * Exported for tests: the CLI is otherwise driven through `main()`, but the forget
 * preview/apply behaviour (ensure:false, preview-writes-nothing, apply deletes) is
 * verified directly to keep the suite hermetic (tmp ABS_HOME, no real ~/.claude).
 */
export async function cmdForget(args: string[]): Promise<void> {
  const selector = parseForgetSelector(args);
  const doApply = args.includes('--apply');
  const yes = args.includes('--yes');

  // ensure:false — forget never embeds (bySearch is FTS-only); avoid a model load.
  const memory = await openMemory(loadConfig(), { ensure: false });
  try {
    const resolved = previewSelector(memory, selector);

    out(`forget preview — ${resolved.ids.length} observation(s) would be deleted:`);
    for (const item of resolved.items) {
      out(`  ${item.id} [${item.kind}] ${item.snippet}`);
    }
    if (resolved.notFound.length > 0) {
      out(`  not found (ignored): ${resolved.notFound.join(', ')}`);
    }
    out('  hard-delete is IRREVERSIBLE — export first (abs export) to keep a recoverable copy.');

    if (resolved.ids.length === 0) {
      out('nothing to delete');
      return;
    }

    if (!doApply) {
      out('(preview — nothing deleted. Re-run with --apply to confirm and delete.)');
      return;
    }

    // readline prompts go to stderr so stdout stays clean for the result summary.
    const rl = yes ? null : createInterface({ input: process.stdin, output: process.stderr });
    const approved: number[] = [];
    try {
      for (const item of resolved.items) {
        if (rl) {
          const ans = (await rl.question(`delete ${item.id} [${item.kind}]? [y/N] `))
            .trim()
            .toLowerCase();
          if (ans !== 'y' && ans !== 'yes') {
            out(`  ${item.id}: skipped`);
            continue;
          }
        }
        approved.push(item.id);
      }
    } finally {
      rl?.close();
    }

    if (approved.length === 0) {
      out(JSON.stringify({ deleted: [], notFound: [] }));
      return;
    }
    const result = executeIds(memory, approved);
    out(JSON.stringify(result));
  } finally {
    memory.close();
  }
}

/** Outcome of resolving the session id: a resolved id, an input error, or none. */
export type SessionResolution = { id: string; source: 'flag' | 'env' } | { error: string } | null;

/**
 * Resolve the current Claude Code session id for `abs project`. Authoritative
 * source is `CLAUDE_CODE_SESSION_ID` (Claude Code sets it for the running
 * session); an explicit `--session <id>` overrides it. There is deliberately NO
 * "latest transcript" fallback — dispatched subagents write their own transcripts
 * into the same project dir, so newest-by-mtime is often the wrong session.
 *
 * A `--session` flag with a missing/flag-shaped value is an ERROR, not a silent
 * fall-back to the env (Codex review on #51): falling through could apply a
 * destructive `--skip` to the ambient session after a typo like
 * `abs project --skip --session --yes`.
 */
export function resolveSessionId(args: string[]): SessionResolution {
  if (hasFlag(args, '--session')) {
    const explicit = optionValue(args, '--session');
    if (explicit === undefined || explicit.startsWith('-')) {
      return { error: '--session requires a session id value' };
    }
    return { id: explicit, source: 'flag' };
  }
  // The env read is centralized in the Claude adapter (multi-harness support); a
  // resolved id from the env keeps the `source: 'env'` semantics.
  const resolved = defaultRegistry().byId('claude-code')?.resolveSession({ env: process.env });
  if (resolved) return { id: resolved.sessionId, source: 'env' };
  return null;
}

export type ProjectAction = { kind: 'status' } | { kind: 'cwd' } | { kind: 'skip' };

/**
 * Parse the single action from the flags. Exactly one of --cwd/--skip (or status).
 * There is deliberately no custom project name: a session's project is ALWAYS its
 * folder (cwd), so `--cwd` files it under that folder (and reverts a prior skip),
 * and `--skip` excludes it.
 */
export function parseProjectAction(args: string[]): ProjectAction | { error: string } {
  const actions: ProjectAction[] = [];
  if (args.includes('--cwd')) actions.push({ kind: 'cwd' });
  if (args.includes('--skip')) actions.push({ kind: 'skip' });
  if (actions.length > 1) return { error: 'choose exactly one of --cwd | --skip' };
  return actions[0] ?? { kind: 'status' };
}

function describeBinding(b: SessionBinding): string {
  return b.action === 'skip' ? 'skip (this session is excluded)' : `set → '${b.project}'`;
}

/**
 * `abs project` — deterministically set/confirm/skip the current session's project
 * (#51). The escape hatch that does not depend on Claude asking: it writes the
 * decision binding (#50) keyed by the resolved session id, applied at the next
 * ingest. `--skip` hard-deletes any already-stored observations for the session,
 * so that destructive path is gated behind `--yes` (ADR-0008).
 */
export async function cmdProject(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const action = parseProjectAction(args);
  if ('error' in action) {
    err(`error: ${action.error}`);
    process.exitCode = 1;
    return;
  }

  const resolved = resolveSessionId(args);
  if (resolved === null) {
    err('error: no current session id — run inside a Claude Code session or pass --session <id>');
    process.exitCode = 1;
    return;
  }
  if ('error' in resolved) {
    err(`error: ${resolved.error}`);
    process.exitCode = 1;
    return;
  }
  const sid = resolved.id;
  const cwd = process.cwd();
  const autoSlug = projectSlug(cwd);

  const memory = await openMemory(loadConfig(), { ensure: false });
  try {
    if (action.kind === 'status') {
      const existing = memory.store.listProjects();
      const binding = readBinding(memory.store, sid);
      const session = memory.store.getSessionByExternalId(sid);
      if (json) {
        out(
          JSON.stringify(
            {
              session: sid,
              sessionSource: resolved.source,
              cwd,
              autoProject: autoSlug,
              storedProject: session?.project ?? null,
              binding: binding ?? null,
              existingProjects: existing,
            },
            null,
            2,
          ),
        );
        return;
      }
      out(`session:        ${sid} (${resolved.source})`);
      out(`cwd:            ${cwd}`);
      out(`auto project:   ${autoSlug}`);
      out(`stored project: ${session?.project ?? '(not ingested yet)'}`);
      out(
        `binding:        ${binding ? describeBinding(binding) : '(none — auto-derivation applies)'}`,
      );
      if (existing.length > 0) {
        out('existing projects:');
        for (const p of existing) out(`  ${p}`);
      } else {
        out('existing projects: (none)');
      }
      out('actions:');
      out(`  --cwd                file this session under its folder (${autoSlug})`);
      out('  --skip               exclude this session (--yes to also delete already-stored obs)');
      out('  (add --session <id> when running outside a Claude Code session)');
      return;
    }

    if (action.kind === 'cwd') {
      const clean = sanitizeProjectName(autoSlug);
      if (clean === null) {
        err(`error: '${autoSlug}' is not a usable project name after sanitizing`);
        process.exitCode = 1;
        return;
      }
      const existed = memory.store.listProjects().includes(clean);
      writeBinding(memory.store, sid, { action: 'set', project: clean });
      // Apply NOW to an already-stored session: if the transcript is fully ingested
      // (cursor at EOF) it may never be re-ingested, so the binding alone would
      // leave the row under its old project (Codex review on #51). The binding
      // still persists for any future lines / not-yet-ingested sessions.
      if (memory.store.getSessionByExternalId(sid)) {
        memory.store.setSessionProject(sid, clean);
      }
      const note = existed ? 'existing' : 'new';
      if (json) {
        out(JSON.stringify({ session: sid, action: 'set', project: clean, kind: note }));
      } else {
        out(`bound session ${sid} → project '${clean}' (${note}). Applies on next ingest.`);
      }
      return;
    }

    // skip — gate the hard delete of any already-stored observations behind --yes.
    const existing = memory.store.getSessionByExternalId(sid);
    const storedCount = existing
      ? previewSelector(memory, { bySession: existing.id }).ids.length
      : 0;
    if (storedCount > 0 && !args.includes('--yes')) {
      if (json) {
        out(
          JSON.stringify({
            session: sid,
            action: 'skip',
            wouldDelete: storedCount,
            applied: false,
          }),
        );
      } else {
        out(
          `skip would HARD-DELETE ${storedCount} stored observation(s) for session ${sid} (IRREVERSIBLE).`,
        );
        out('export first (abs export); re-run with --yes to confirm skip + delete.');
      }
      return; // nothing written without confirmation
    }
    writeBinding(memory.store, sid, { action: 'skip' });
    if (json) {
      out(JSON.stringify({ session: sid, action: 'skip', deleted: storedCount, applied: true }));
    } else {
      const tail = storedCount > 0 ? ` Deleted ${storedCount} stored observation(s).` : '';
      out(`session ${sid} marked skip — not stored.${tail}`);
    }
  } finally {
    memory.close();
  }
}

/** `abs remember "<text>" --global [--kind K]` — author a global-brain memory. */
export async function cmdRemember(args: string[]): Promise<void> {
  const json = args.includes('--json');
  // F6-01: resolve the text WITHOUT letting the shared `positional()` mistake the
  // value of the only value-taking flag (`--kind`) for the text. The `--kind=value`
  // inline form is already a single `-`-prefixed token `positional()` skips; the
  // space form (`--kind lesson "text"`) needs the pair dropped first.
  const text = positional(stripFlagPair(args, '--kind'));
  if (!text) {
    err('error: remember requires text, e.g. `abs remember "..." --global`');
    process.exitCode = 1;
    return;
  }
  if (!args.includes('--global')) {
    err('error: `abs remember` currently writes only to the global brain — pass --global');
    process.exitCode = 1;
    return;
  }
  const kind = optionValue(args, '--kind') ?? 'note';
  const memory = await openMemory(loadConfig(), { ensure: false });
  try {
    const sessionId = getOrCreateGlobalSession(memory.store);
    const id = await memory.indexer.write({ sessionId, kind, content: text });
    if (json) out(JSON.stringify({ id, scope: 'global', kind, applied: true }));
    else out(`remembered to the global brain (id ${id}, ${kind}).`);
  } finally {
    memory.close();
  }
}

/**
 * `abs promote <id> [--as "<text>"]` — promote a project memory into the global brain.
 * Without `--as` it moves the whole memory; with `--as` it files a curated copy of
 * exactly that text and keeps the original (the leak-safe path). See `promoteAction`.
 */
export async function cmdPromote(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const asPresent = hasFlag(args, '--as');
  const asValue = optionValue(args, '--as');
  // Resolve the id WITHOUT teaching the shared `positional()` about --as: drop the
  // `--as <value>` pair from a local copy so the curated text can't be read as the id
  // (e.g. `promote --as "use X" 42` must still resolve 42).
  const idArg = positional(stripFlagPair(args, '--as'));
  const id = idArg ? Number.parseInt(idArg, 10) : Number.NaN;
  // Strict parse (matches the --session/--ids sites): reject "42a", "42.9", ≤ 0 —
  // parseInt would silently truncate and promote the wrong observation.
  if (!Number.isInteger(id) || id <= 0 || String(id) !== (idArg ?? '').trim()) {
    err('error: promote requires a positive observation id, e.g. `abs promote 42`');
    process.exitCode = 1;
    return;
  }
  if (asPresent && (asValue ?? '').trim().length === 0) {
    err('error: promote --as requires non-empty text, e.g. `abs promote 42 --as "prefer X"`');
    process.exitCode = 1;
    return;
  }
  // A `--…`-looking value almost always means the user forgot the text (e.g.
  // `promote 42 --as --json`), which would otherwise file the literal flag as a
  // memory. Reject it; genuine curated text never needs to begin with `--`.
  if (asPresent && (asValue ?? '').trim().startsWith('--')) {
    err(
      'error: promote --as value looks like a flag — pass the curated text, e.g. `abs promote 42 --as "prefer X"`',
    );
    process.exitCode = 1;
    return;
  }
  const memory = await openMemory(loadConfig(), { ensure: false });
  try {
    const result = await promoteAction(memory, { id, as: asPresent ? asValue : undefined });
    if (result.error) {
      err(`error: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (json) out(JSON.stringify(result));
    else if (result.curated)
      out(
        `promoted observation ${id} to the global brain as new observation ${result.newId} (original kept).`,
      );
    else out(`promoted observation ${id} to the global brain.`);
  } finally {
    memory.close();
  }
}

/**
 * Read the value of `--flag`, accepting BOTH supported forms:
 *   space form   `--flag value`  → the token after `--flag`
 *   inline form  `--flag=value`  → the substring after the first `=` (may be empty)
 * Returns undefined when the flag is absent (or is the space form with no following
 * token). `--flag=` yields '' rather than swallowing the next token.
 */
export function optionValue(args: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    if (a === flag) return args[i + 1];
  }
  return undefined;
}

/**
 * Presence test for a VALUE-taking flag, accepting BOTH forms — the bare `--flag`
 * (space form, value follows) and `--flag=value` (inline). A plain `args.includes('--flag')`
 * misses the inline form, so a caller that gates on presence and then reads the value with
 * `optionValue` would IGNORE `--flag=value` entirely (e.g. an explicit `--session=other`
 * silently falling back to the ambient session — a destructive footgun). Boolean flags
 * have no `=value` form, so they keep using `args.includes`.
 */
export function hasFlag(args: string[], flag: string): boolean {
  const prefix = `${flag}=`;
  return args.some((a) => a === flag || a.startsWith(prefix));
}

/**
 * A copy of `args` with EVERY occurrence of `flag` removed, including its value:
 *   space form   `--flag value`  → drops both tokens
 *   inline form  `--flag=value`  → drops the single token
 * Lets a command resolve its positional without the shared `positional()` mistaking
 * a flag's value for the positional. ALL occurrences are dropped (not just the first):
 * a duplicate value flag (`--kind a --kind b text`) would otherwise leave the second
 * pair behind and `positional()` would read that value (`b`) as the positional.
 */
export function stripFlagPair(args: string[], flag: string): string[] {
  const prefix = `${flag}=`;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith(prefix)) continue; // inline form — drop this single token
    if (a === flag) {
      if (args[i + 1] !== undefined) i += 1; // space form — also skip its value token
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * All values of a repeatable flag, accepting both forms per occurrence:
 * `--project a --project=b` → ['a','b']. The inline `--flag=` contributes an empty
 * string (mirrors optionValue); the space form contributes only when a following
 * token exists.
 */
export function optionValues(args: string[], flag: string): string[] {
  const prefix = `${flag}=`;
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith(prefix)) values.push(a.slice(prefix.length));
    else if (a === flag && args[i + 1] !== undefined) values.push(args[i + 1] as string);
  }
  return values;
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
      return cmdStart(rest);
    case 'ingest':
      return cmdIngest(rest);
    case 'status':
      return cmdStatus();
    case 'doctor':
      return cmdDoctor();
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
    case 'opencode-capture':
      return cmdOpencodeCapture(rest);
    case 'opencode-recall':
      return cmdOpencodeRecall(rest);
    case 'install-hooks':
      return cmdInstallHooks(rest);
    case 'setup':
      return cmdSetup(rest);
    case 'uninstall':
      return cmdUninstall(rest);
    case 'optimize':
      return cmdOptimize(rest);
    case 'maintain':
      return cmdMaintain(rest);
    case 'forget':
      return cmdForget(rest);
    case 'project':
      return cmdProject(rest);
    case 'promote':
      return cmdPromote(rest);
    case 'remember':
      return cmdRemember(rest);
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
