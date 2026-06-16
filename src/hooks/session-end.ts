/**
 * SessionEnd hook handler (#15, scoped in #62) — auto-ingest on session close, $0,
 * no LLM.
 *
 * When a Claude Code session ends, Claude Code runs this with the hook payload on
 * stdin. We ingest ONLY the just-finished session's transcript (`transcript_path`
 * from the payload) via `ingestSingleSession` — never a full-tree scan. This is the
 * #62 fix: a full scan re-ingested the machine's whole history whenever the store
 * was fresh/reset (its byte-cursors live in the same DB), silently back-filling
 * unrelated projects. Pulling historical transcripts is now an explicit `abs ingest`
 * action; the hook stays scoped to the current session. The default local embedding
 * provider indexes the lines ($0, offline); we NEVER call consolidate/LLM here (#12).
 *
 * SessionEnd cannot inject context, so this handler returns `undefined` (no stdout).
 * It runs behind `runHookSafely`, so any failure here is swallowed and the session
 * is never blocked (ADR-0004). We open memory with the default ensure gate so a
 * drifted index self-heals, then always close the store.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { EmbeddingLoadTimeoutError } from '../embedding/index.js';
import type { GroundTruthProvider } from '../ground-truth/index.js';
import { ingestSingleSession } from '../ingest/index.js';
import { runPostCaptureMaintenance } from '../maintenance/index.js';
import { openMemory } from '../memory.js';
import { EMBED_DEGRADED_KEY, INGEST_DEFERRED_KEY, isRebuildLocked } from '../store/index.js';
import type { HookPayload } from './payload.js';

/** Bound the first-run model load on the hook path, well under the 8s runner budget (#111). */
const HOOK_EMBED_BUDGET_MS = 6_000;

/**
 * Absolute path to the built CLI entry (`dist/cli/cli.js`), resolved from this module
 * (`dist/hooks/session-end.js`) via `import.meta.url` — NOT `process.cwd()`, which on
 * the hook path is the user's project, not the install. `process.execPath <cliPath>
 * maintain --auto` is what the detached cadence spawns.
 */
function resolveCliPath(): string {
  return fileURLToPath(new URL('../cli/cli.js', import.meta.url));
}

/**
 * Spawn the auto-distill cadence runner DETACHED (#138, copies the `openBrowser`
 * pattern in cli.ts): `process.execPath <cliPath> maintain --auto` with stdio ignored,
 * its own process group (`detached`), and `unref()` so SessionEnd returns immediately
 * and the child outlives the hook. A spawn failure is swallowed (ADR-0004 fail-open) —
 * the cadence is a background nicety, never a blocker on session close.
 *
 * `cwd` is passed EXPLICITLY (the session's project dir) rather than relying on the
 * child inheriting the hook's cwd: the runner scopes its optimize pass + cursor keys to
 * `projectSlug(process.cwd())`, and the banner reads those keys under the session's
 * `project` slug — pinning the child's cwd to the session dir keeps writer and reader
 * on the same slug (closes the implicit-coupling footgun the integration check flagged).
 */
function spawnCadence(cliPath: string, cwd: string): void {
  const child = spawn(process.execPath, [cliPath, 'maintain', '--auto'], {
    cwd,
    stdio: 'ignore',
    detached: true,
    shell: false,
  });
  child.on('error', () => {}); // swallow ENOENT etc. — the cadence is best-effort
  child.unref();
}

export interface SessionEndDeps {
  /** Injection seam for tests — defaults to the real openMemory + ingest. */
  ingest?: (transcriptPath: string) => Promise<void>;
  /** Injection seam for tests — defaults to the cwd-rooted ground-truth provider. */
  groundTruth?: GroundTruthProvider;
  /**
   * Injection seam for tests — override the embed-readiness gate. Defaults to
   * `memory.provider.ensureReady`; the real local provider caches the model after
   * the first run, so the first-run timeout (#111) can only be exercised via a mock.
   */
  embedReady?: (opts: { budgetMs?: number }) => Promise<void>;
  /**
   * Injection seam for tests — the detached cadence spawn (#138). Defaults to the real
   * `spawnCadence` (detached `abs maintain --auto`); unit tests pass a spy so no real
   * subprocess is launched. Receives the resolved CLI entry path.
   */
  spawnCadence?: (cliPath: string, cwd: string) => void;
}

/**
 * Ingest the current session's transcript. Resolves `undefined` (SessionEnd injects
 * nothing). A payload without `transcript_path` is a no-op — we deliberately do NOT
 * fall back to a full-tree scan (that is the historical back-fill #62 removes).
 * Throws on failure — the caller (`runHookSafely`) swallows it.
 */
export async function handleSessionEnd(
  payload: HookPayload,
  deps: SessionEndDeps = {},
): Promise<undefined> {
  const transcriptPath = payload.transcriptPath;
  if (!transcriptPath) return undefined; // nothing to scope to — never full-scan

  if (deps.ingest) {
    await deps.ingest(transcriptPath);
    return undefined;
  }
  // If the MCP server is mid-rebuild it holds the cross-process write lock; racing
  // our ingest writes into it would block on busy_timeout and then fail-open,
  // SILENTLY losing this session's memory (#103). Defer instead: record a durable
  // marker + log one line. Nothing is lost — the transcript's byte-cursor is not
  // advanced, so a later `abs ingest` (or the next unlocked SessionEnd) re-pulls it.
  const { dbPath } = loadConfig();
  if (isRebuildLocked(dbPath)) {
    // The stderr log is the RELIABLE defer signal — emit it first, unconditionally.
    // The kv_meta marker is a best-effort nicety: writing it touches the same DB the
    // rebuild writer is holding, so under contention it could hit busy_timeout. We
    // must never let that throw and undo the defer, so it is swallowed.
    process.stderr.write(
      '[abs] session-end ingest deferred: an index rebuild is in progress; ' +
        'this session will be re-ingested later (no data lost).\n',
    );
    try {
      const memory = await openMemory(undefined, { ensure: false });
      try {
        memory.store.setMeta(INGEST_DEFERRED_KEY, new Date().toISOString());
      } finally {
        memory.close();
      }
    } catch {
      // best-effort marker — the stderr log above already records the deferral.
    }
    return undefined;
  }

  const memory = await openMemory();
  try {
    // #111: ingest embeds, so a first-EVER run would trigger the ~35s model download.
    // Bound it well under the 8s hook budget; on timeout, record a degraded note and
    // defer (the cursor is NOT advanced, so the next run re-ingests once an unbudgeted
    // `abs ingest` has cached the model). The load keeps running in the background.
    const ensureReady = deps.embedReady ?? memory.provider.ensureReady?.bind(memory.provider);
    if (ensureReady) {
      try {
        await ensureReady({ budgetMs: HOOK_EMBED_BUDGET_MS });
      } catch (err) {
        if (err instanceof EmbeddingLoadTimeoutError) {
          process.stderr.write(
            '[abs] session-end ingest deferred: the embedding model is still downloading ' +
              '(first run, ~35s). Run `abs ingest --apply` once to cache it; this session ' +
              'will be re-ingested afterward (no data lost).\n',
          );
          try {
            memory.store.setMeta(EMBED_DEGRADED_KEY, new Date().toISOString());
          } catch {
            // best-effort note — the stderr log above is the reliable signal
          }
          return undefined;
        }
        throw err;
      }
    }

    // Capture the resolved session id (#138/W2) so the cadence-due gate below can scope
    // a per-session obs count. One transcript = one session on this path.
    const { sessionId } = await ingestSingleSession(memory, transcriptPath);

    // #26/#107 integration: promote the just-seeded `claimed` anchors against ground
    // truth, OUT of the interactive hot path. Shared with the OpenCode capture path so
    // every harness verifies anchors the same way (#107). Fail-open (ADR-0004).
    const cwd = payload.cwd ?? process.cwd();
    await runPostCaptureMaintenance(
      memory.store,
      cwd,
      deps.groundTruth ? { groundTruth: deps.groundTruth } : {},
    );

    // Cadence-due eval + detached spawn (#138). This lives on the REAL-ingest branch
    // ONLY — it is unreachable from the `deps.ingest` short-circuit, the rebuild-lock
    // defer, and the embed-timeout defer (all three early-return above). Due when an LLM
    // is configured (consolidate cannot run without it), auto-distill is not opted out,
    // and the just-ended session is substantial (>= distillMinObs). If due, spawn the
    // runner DETACHED and return immediately — NO LLM/network call on the hook path. The
    // spawn is fail-open (ADR-0004): a throw is swallowed so close is never blocked.
    const cfg = loadConfig();
    const obsCount = sessionId != null ? memory.store.countObservationsBySession(sessionId) : 0;
    const due = cfg.llm !== undefined && cfg.autoDistill && obsCount >= cfg.distillMinObs;
    if (due) {
      try {
        (deps.spawnCadence ?? spawnCadence)(resolveCliPath(), cwd);
      } catch {
        // best-effort — a spawn failure must never undo the session close (ADR-0004)
      }
    }
  } finally {
    memory.close();
  }
  return undefined;
}
