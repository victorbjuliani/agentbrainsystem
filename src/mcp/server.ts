/**
 * MCP server (issues #6 / #10) — exposes the memory over the Model Context
 * Protocol so Claude Code can recall and store memories as tools.
 *
 * Tools:
 *   - `recall`         — hybrid semantic + keyword search, returns ranked hits.
 *   - `remember`       — persist a new observation (index-at-write).
 *   - `memory_status`  — real index counts + staleness (never cosmetic).
 *   - `optimize`       — generate evidence-backed candidate diffs (read-only).
 *   - `apply`          — write ONE previewed candidate to disk (gated).
 *   - `forget_preview` — resolve what a delete would remove, mint a handle (read-only).
 *   - `forget`         — DELETE the previewed set for a handle (IRREVERSIBLE).
 *   - `set_session_project` — record this session's project decision (set/skip), #52.
 *
 * `createMcpServer` builds the server from an open `Memory`; `startStdio` is the
 * process entrypoint the CLI/packaging launches over stdio.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { DeleteRefusalError, type DeleteSelector, execute, preview } from '../delete/index.js';
import { getOrCreateGlobalSession, promoteAction } from '../global.js';
import { defaultRegistry } from '../harness/index.js';
import { clearBinding, defaultClaudeProjectsDir, writeBinding } from '../ingest/index.js';
import {
  AUTO_DISTILL_LAST_RUN_AT,
  AUTO_DISTILL_RUNS,
  AUTO_DISTILL_TOKENS,
} from '../maintain/index.js';
import { type Memory, openMemory } from '../memory.js';
import {
  advanceOptimizeCursorsAfterApply,
  applyApprovedCandidate,
  generateOptimizations,
  type OptimizeCandidate,
  projectSlug,
} from '../optimize/index.js';
import { annotateFreshness, resolveRecallProject } from '../recall/index.js';
import { acquireRebuildLock, REBUILD_FAILED_KEY, REBUILD_HEARTBEAT_MS } from '../store/index.js';
import { VERSION } from '../version.js';

/** Default external session id used when a `remember` call omits one. */
const DEFAULT_SESSION = 'mcp';

/**
 * Resolve the bound session id from the environment via the HARNESS that launched
 * this MCP server (#109). The server is registered with `start --harness <id>` so
 * shared code no longer hard-codes claude-code: a Codex/Gemini/Copilot/OpenCode
 * server resolves through its own (payload-only) adapter and so never binds a stale
 * `CLAUDE_CODE_SESSION_ID` that leaked into the process env. Precedence at the call
 * site is always: explicit `session` arg > this env resolution. When the harness is
 * unknown (a legacy registration without the flag) we fall back to claude-code so
 * existing Claude installs behave exactly as before.
 */
function envSession(
  harnessId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const adapter =
    (harnessId ? defaultRegistry().byId(harnessId) : undefined) ??
    defaultRegistry().byId('claude-code');
  return adapter?.resolveSession({ env })?.sessionId;
}

function jsonContent(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * Read the auto-distill observability rollup (#138/§1.5, P4) from kv_meta — run count +
 * cumulative tokens + last-run timestamp — so `memory_status` surfaces the otherwise
 * silent background spend as auditable. The key constants are shared with the cadence
 * runner (the writer) via `../maintain`, so reader and writer never drift. Absent keys
 * default to a zeroed/null rollup (a fresh install that has never auto-distilled).
 */
function readAutoDistillRollup(store: Memory['store']): {
  runs: number;
  tokens: number;
  lastRunAt: string | null;
} {
  const readInt = (key: string): number => {
    const raw = store.getMeta(key);
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  };
  return {
    runs: readInt(AUTO_DISTILL_RUNS),
    tokens: readInt(AUTO_DISTILL_TOKENS),
    lastRunAt: store.getMeta(AUTO_DISTILL_LAST_RUN_AT),
  };
}

/**
 * The single place the rebuild-readiness contract lives (#104): wait for the
 * background startup rebuild (if any) before an index-touching tool runs, so no
 * handler reads or mutates a half-built index. A no-op once `ready` has resolved,
 * and on the synchronous (CLI) path where `ready` is undefined. Only tool CALLS
 * await this — the MCP `initialize` handshake stays instant.
 */
export function withReady<T>(memory: Pick<Memory, 'ready'>, fn: () => Promise<T>): Promise<T> {
  return memory.ready ? memory.ready.then(fn) : fn();
}

/**
 * Get-or-create a session by external id, tolerating a concurrent creator: if two
 * callers race and the second hits the UNIQUE(external_id) constraint, re-read the
 * row the winner inserted instead of surfacing the conflict.
 */
function resolveSession(memory: Memory, externalId: string): number {
  const existing = memory.store.getSessionByExternalId(externalId);
  if (existing) return existing.id;
  try {
    return memory.store.createSession({ externalId });
  } catch {
    const winner = memory.store.getSessionByExternalId(externalId);
    if (winner) return winner.id;
    throw new Error(`could not resolve session '${externalId}'`);
  }
}

export function createMcpServer(memory: Memory, harnessId?: string): McpServer {
  const server = new McpServer({ name: 'agentbrainsystem', version: VERSION });

  server.registerTool(
    'recall',
    {
      title: 'Recall memories',
      description:
        "Hybrid semantic + keyword search over stored agent memory. Returns the most relevant past observations for a query. Scoped to the current session's project by default (ABS_RECALL_SCOPE); pass `project` to target a specific one, or set scope=global for store-wide recall.",
      inputSchema: {
        query: z.string().describe('What to search memory for.'),
        limit: z.number().int().positive().max(50).optional().describe('Max results (default 10).'),
        project: z
          .string()
          .optional()
          .describe(
            'Restrict to this project label. Default: the current project (or store-wide if scope=global).',
          ),
      },
    },
    async ({ query, limit, project }) =>
      withReady(memory, async () => {
        // Explicit `project` wins (empty string = "no explicit project", not a
        // zero-match filter). Otherwise resolve the scope from the session BINDING
        // first, then the stored row, then the cwd slug (#47 `resolveRecallProject`)
        // — a freshly-written `set_session_project` binding whose row isn't updated
        // yet is honored, so recall can't leak store-wide before the next ingest
        // (Codex review on #47). Under ABS_RECALL_SCOPE=global → undefined → store-wide.
        const explicit = project && project.length > 0 ? project : undefined;
        const scopeProject =
          explicit ??
          resolveRecallProject(memory.store, {
            scope: loadConfig().recallScope,
            sessionId: envSession(harnessId),
            cwd: process.cwd(),
          });
        // includeGlobal: the curated cross-project global brain is recalled alongside
        // the project (no-op when already store-wide). Keeps the MCP pull path in sync
        // with the per-prompt hook injection.
        // rankByKind (#143): durable kinds (decision/lesson/note) lead over raw turns —
        // the hybrid-path twin of the per-prompt hook. `score` stays the raw fused
        // relevance (the weight reorders only). annotateFreshness then sinks `stale` hits
        // below trustworthy ones, so kind-weighting can NEVER promote a stale curated fact
        // to the top of an MCP result without its ⚠ tag (the hybrid path has no other
        // freshness step — that demotion otherwise lives only on the recallFts hook path).
        //
        // Demote stale across the ENTIRE candidate pool, THEN slice to the requested limit
        // (Codex review on PR #173). annotateFreshness only REORDERS the hits recall()
        // returned — it can't pull in one recall() never returned. At a small `limit`,
        // kind-weighting can promote STALE curated hits into the window and push the fresh
        // match out, so a post-recall demotion has no fresh hit left to surface. A FIXED
        // over-fetch only moves the cliff (it fails once the stale run exceeds the window);
        // instead we return recall's WHOLE fused candidate pool (limit = candidates×2) and
        // demote over all of it, so a fresh hit anywhere among the candidates beats stale
        // before the slice. A fresh hit OUTSIDE the candidate pool was never recallable (it
        // didn't rank in the top-`candidates` of either leg = below recall's relevance
        // horizon), so excluding it is correct. The floor is widened to 50/leg (vs recall's
        // default 20) so a long run of stale curated hits ahead of a fresh match doesn't
        // exhaust the pool at small limits — the demotion sees ~100 fused candidates deep.
        const want = limit ?? 10;
        const candidates = Math.max(want * 5, 50); // generous horizon so stale runs don't starve fresh
        const pool = annotateFreshness(
          memory.store,
          await memory.recall.recall(query, {
            limit: candidates * 2, // ≥ the fused pool (vector⊕FTS) → demotion sees every candidate
            candidates,
            project: scopeProject,
            includeGlobal: true,
            rankByKind: true,
            noiseFloor: true, // #144: drop best-of-the-junk → "nothing relevant" returns []
          }),
        );
        const hits = pool.slice(0, want);
        return jsonContent(
          hits.map((h) => ({
            id: h.observation.id,
            kind: h.observation.kind,
            content: h.observation.content,
            score: Number(h.score.toFixed(6)),
            anchorState: h.anchorState,
            vectorRank: h.vectorRank,
            ftsRank: h.ftsRank,
            createdAt: h.observation.createdAt,
          })),
        );
      }),
  );

  server.registerTool(
    'remember',
    {
      title: 'Remember an observation',
      description: 'Persist a new memory. It is embedded and indexed immediately (index-at-write).',
      inputSchema: {
        content: z.string().min(1).describe('The text to remember.'),
        kind: z.string().optional().describe('Category, e.g. decision/lesson/note (default note).'),
        session: z.string().optional().describe('External session id to group the memory under.'),
        scope: z
          .enum(['project', 'global'])
          .optional()
          .describe(
            "Where to file it. 'global' (cross-project brain, recalled in every project) ONLY when the user explicitly asks to save globally — never on your own initiative. Default 'project'.",
          ),
      },
    },
    async (args) => withReady(memory, async () => jsonContent(await rememberAction(memory, args))),
  );

  server.registerTool(
    'memory_status',
    {
      title: 'Memory status',
      description: 'Real index counts and staleness for the memory store.',
      inputSchema: {},
    },
    async () =>
      withReady(memory, async () =>
        jsonContent({
          // Additive SPREAD (W3): every pre-existing top-level field is preserved; the
          // `autoDistill` rollup (#138/P4) is layered on so the output stays a superset.
          ...memory.indexer.status(),
          autoDistill: readAutoDistillRollup(memory.store),
        }),
      ),
  );

  // Optimize loop (#21). `optimize` generates evidence-backed candidate diffs
  // (read-only); `apply` writes ONE of those candidates to disk through the gated
  // applier. The cache makes `apply` accept only candidates THIS server generated
  // — the agent cannot fabricate a diff/target — keeping the gated-apply trust
  // boundary (#20). The proactive flow is: agent reads the SessionStart staleness
  // flag → calls `optimize` → shows the diffs → the USER approves → agent calls
  // `apply` per approved id. `apply` never auto-writes: it is an explicit call and
  // the fail-closed user|feedback guard still refuses protected entries.
  //
  // `optimizeCache` indexes the CURRENT run's candidates by id (fast `apply` lookup);
  // `optimizeRun` holds the run-wide context the per-kind cursor advance needs (#138
  // FIX2): the FULL candidate list, the un-sliced `survivingIds` keep-set, the
  // `projectRoot`, and the set of ids already applied this run. Each `optimize`
  // REPLACES both — a fresh run invalidates the prior one's ids. The CLI + cadence
  // advance the cursor via `advanceOptimizeCursorsAfterApply`; `apply` now does the
  // same so the MCP path never leaves the cursor stale (it keeps nagging otherwise).
  const optimizeCache = new Map<string, OptimizeCandidate>();
  let optimizeRun:
    | {
        projectRoot: string;
        survivingIds: number[];
        candidates: OptimizeCandidate[];
        applied: Set<string>;
      }
    | undefined;

  server.registerTool(
    'optimize',
    {
      title: 'Generate memory optimizations',
      description:
        "Turn distilled memory (consolidated lessons/decisions) into evidence-backed candidate diffs for this project's CLAUDE.md / Claude Code auto-memory. Read-only — writes NOTHING. Show the diffs to the user and get approval before calling `apply`.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe('Project root whose CLAUDE.md / auto-memory are targets (default: cwd).'),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe('Max candidates to return (default 20).'),
      },
    },
    async ({ project, limit }) =>
      withReady(memory, async () => {
        const projectRoot = project ?? process.cwd();
        const { candidates, estimate, survivingIds } = await generateOptimizations(
          memory,
          loadConfig(),
          {
            projectRoot,
            ...(limit !== undefined ? { limit } : {}),
          },
        );
        optimizeCache.clear();
        for (const c of candidates) optimizeCache.set(c.id, c);
        // Pin the run-wide context the cursor advance needs (#138 FIX2): a fresh run
        // REPLACES the prior one, so a stale id never advances against the wrong keep-set.
        optimizeRun = { projectRoot, survivingIds, candidates, applied: new Set<string>() };
        return jsonContent({
          candidates: candidates.map((c) => ({
            id: c.id,
            priority: c.priority,
            title: c.title,
            rationale: c.rationale,
            target: { kind: c.target.kind, path: c.target.absPath },
            evidenceIds: c.evidenceIds,
            diff: c.diff,
            // Only the index DIFF is exposed (#140) — proposedText/absPath stay server-side,
            // matching how baseContent is never serialized.
            ...(c.indexWrite ? { indexDiff: c.indexWrite.diff } : {}),
          })),
          estimate,
        });
      }),
  );

  server.registerTool(
    'apply',
    {
      title: 'Apply a memory optimization',
      description:
        'WRITES one optimization candidate (from a prior `optimize` call) to disk: backup + atomic write + rollback. Only apply candidates the user has approved. Refuses (no write) on a forbidden target or a protected user|feedback auto-memory entry.',
      inputSchema: {
        candidateId: z
          .string()
          .describe('The id of a candidate returned by a prior `optimize` call.'),
      },
    },
    async ({ candidateId }) =>
      withReady(memory, async () => {
        const candidate = optimizeCache.get(candidateId);
        if (!candidate || !optimizeRun) {
          // Candidate ids live in this in-process Map (#114) and do NOT survive a
          // server restart. An empty cache has two innocent causes — the last
          // `optimize` produced no candidates, OR the server restarted since the ids
          // were minted — so name BOTH rather than asserting a restart (the cache is
          // also empty right after a zero-candidate optimize). A non-empty cache means
          // this id is genuinely not among the current candidates.
          const error =
            optimizeCache.size === 0
              ? `candidate id '${candidateId}' is not loaded — no optimize candidates are in memory. ` +
                'Either the last `optimize` produced none, or the MCP server restarted since the ids ' +
                'were minted (they do not survive a restart). Re-run `optimize` to refresh candidates, then apply.'
              : `unknown candidate id '${candidateId}' — it is not among the current candidates. ` +
                'Re-run `optimize` to refresh candidates, then apply.';
          return jsonContent({ error });
        }
        const run = optimizeRun;
        const result = await applyApprovedCandidate(memory, candidate, {
          projectRoot: run.projectRoot,
          projectsDir: defaultClaudeProjectsDir(),
        });
        // Advance the per-kind/project cursor on a successful write (#138 FIX2). The CLI
        // + cadence advance once after their apply loop; MCP applies candidates one at a
        // time, so we re-run the advance after EACH apply with the cumulative applied set.
        // It is idempotent and converges: a kind's cursor advances only once its LAST
        // surviving candidate has been applied (`pendingValid` empty), so re-running it
        // per apply never over- or under-advances. A refusal/no-write does not mark the
        // id applied, so it can't move the cursor.
        if (result.applied) {
          run.applied.add(candidate.id);
          advanceOptimizeCursorsAfterApply(
            memory,
            projectSlug(run.projectRoot),
            new Set(run.survivingIds),
            run.candidates,
            run.applied,
          );
        }
        return jsonContent(result);
      }),
  );

  // Selective hard-delete (Phase B). `forget_preview` resolves a selector to a
  // concrete id set and mints a handle (the core parks the pinned ids in its own
  // TTL cache); `forget` deletes ONLY that handle's pinned set. The two-tool split
  // is the trust boundary: `forget` takes a handle — never a raw selector — so the
  // agent can only delete a set the server previewed and the USER saw and approved
  // (mirrors optimize/apply). A handle is single-use: it is consumed on `forget`, so
  // a replay (or a second call) returns `unknown-handle`. There is deliberately NO
  // `.abs-bak` for deletes (unlike apply) — hard-delete is IRREVERSIBLE and
  // export-first (the `export` surface) is the only recovery.

  server.registerTool(
    'forget_preview',
    {
      title: 'Preview a memory delete',
      description:
        'Resolve what a delete would remove. Read-only — deletes NOTHING. Show the items to the user and get explicit approval before calling forget. Returns a single-use handle that forget consumes. Pass exactly one selector.',
      inputSchema: {
        ids: z
          .array(z.number().int().positive())
          .min(1)
          .max(10_000)
          .optional()
          // `.min(1)`: an empty `ids:[]` must hard-error like the CLI/UI, not silently
          // resolve to a count-0 selector that looks like a valid (no-op) delete.
          .describe('Explicit observation ids to delete (1–10000).'),
        session: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Delete every observation of this session id.'),
        project: z
          .string()
          .optional()
          .describe(
            'Delete observations of every session with this project name (literal string).',
          ),
        nullProject: z
          .boolean()
          .optional()
          .describe(
            'Delete observations of sessions with NO project (distinct from the literal "null").',
          ),
        search: z
          .string()
          .optional()
          .describe('Delete observations matched by FTS keyword recall (no embedding).'),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe('Cap for the search selector (default uses the FTS default).'),
      },
    },
    async ({ ids, session, project, nullProject, search, limit }) =>
      withReady(memory, async () => {
        const chosen = [
          ids !== undefined,
          session !== undefined,
          project !== undefined,
          nullProject === true,
          search !== undefined,
        ].filter(Boolean).length;
        if (chosen !== 1) {
          return jsonContent({
            error:
              'forget_preview requires exactly one selector: ids, session, project, nullProject, or search',
          });
        }
        let selector: DeleteSelector;
        if (ids !== undefined) selector = { byIds: ids };
        else if (session !== undefined) selector = { bySession: session };
        else if (project !== undefined) selector = { byProject: project };
        else if (nullProject === true) selector = { byProject: null };
        else
          selector = {
            bySearch: { query: search as string, ...(limit !== undefined ? { limit } : {}) },
          };

        const result = preview(memory, selector);
        return jsonContent({
          handle: result.handle,
          count: result.count,
          items: result.items,
          notFound: result.notFound,
          selectorEcho: result.selectorEcho,
        });
      }),
  );

  server.registerTool(
    'forget',
    {
      title: 'Execute a previewed delete',
      description:
        'DELETE the previously-previewed set for this handle. IRREVERSIBLE. Only on explicit user approval; never automatic. Recovery is export-first only.',
      inputSchema: {
        handle: z.string().describe('The handle returned by a prior forget_preview call.'),
      },
    },
    async ({ handle }) =>
      withReady(memory, async () => {
        try {
          const result = execute(memory, handle);
          return jsonContent(result);
        } catch (e) {
          if (e instanceof DeleteRefusalError) {
            return jsonContent({ error: e.message, reason: e.reason });
          }
          throw e;
        }
      }),
  );

  // Session→project decision (#52, F6). The agent-mediated writer the SessionStart
  // picker drives: Claude asks the user, then records the choice here. Mirrors
  // `abs project` (#51) over MCP — same sanitization and the same skip semantics,
  // INCLUDING the destructive-delete confirmation gate (`confirmDelete`, the MCP
  // analog of the CLI's `--yes`; ADR-0008). The session id must be the CURRENT
  // session's id — the picker passes it explicitly; the env var is a last resort.
  server.registerTool(
    'set_session_project',
    {
      title: 'Skip or include this session in memory',
      description:
        "Decide whether the CURRENT session is saved to memory. The project is ALWAYS the session's folder (its cwd) — there is no name to choose. action='skip' excludes the session from memory; action='include' reverts a prior skip so it is saved under its folder again. Pass `session` (the id from the SessionStart notice); if omitted it falls back to the launching harness's session env (claude-code only). SKIP IS IRREVERSIBLE: it hard-deletes any already-stored observations for the session — that delete only runs with confirmDelete=true (export first via `abs export`); otherwise it returns a preview with the count.",
      inputSchema: {
        action: z
          .enum(['skip', 'include'])
          .describe("'skip' to exclude this session from memory, 'include' to revert a skip."),
        session: z
          .string()
          .optional()
          .describe(
            "The current session id (from the notice). Falls back to the launching harness's session env (claude-code only).",
          ),
        confirmDelete: z
          .boolean()
          .optional()
          .describe(
            'Required to confirm the IRREVERSIBLE hard-delete when skip would remove stored observations.',
          ),
      },
    },
    // EXEMPT from withReady (#104): set_session_project writes only the session→project
    // binding (and, on a confirmed skip, deletes that session's own rows) — it never
    // reads or rebuilds the recall index, so it has no dependency on the background
    // rebuild being finished. Gating it would needlessly delay a project decision.
    async (args) => jsonContent(setSessionProjectAction(memory, args, harnessId)),
  );

  // Promote an existing memory into the cross-project global brain (#). Without `as`
  // it MOVES the whole observation; with `as` it files a curated COPY of exactly that
  // text and keeps the original (the leak-safe path). User-initiated only — never on
  // the agent's own initiative.
  server.registerTool(
    'promote',
    {
      title: 'Promote a memory to the global brain',
      description:
        'Promote an observation into the cross-project global brain (recalled in every project). Without `as`, MOVES the whole observation. With `as`, files a CURATED COPY containing exactly that text and KEEPS the original in its project — use this to promote only the reusable part and leave project-specific or sensitive detail behind. Use ONLY when the user explicitly asks — never on your own initiative.',
      inputSchema: {
        id: z.number().int().describe('Observation id to promote.'),
        as: z
          .string()
          .optional()
          .describe(
            'Curated text to file globally instead of moving the original (keeps the original).',
          ),
      },
    },
    async ({ id, as }) =>
      withReady(memory, async () => {
        const result = await promoteAction(memory, { id, as });
        return jsonContent(result.error ? { error: result.error } : result);
      }),
  );

  return server;
}

/** Arguments accepted by {@link rememberAction}. */
export interface RememberArgs {
  content: string;
  kind?: string;
  session?: string;
  scope?: 'project' | 'global';
}

/**
 * Core of the `remember` MCP tool, extracted for direct testing. `scope:"global"`
 * files the memory under the reserved global brain (cross-project) — the agent must
 * only pass it when the user explicitly asks; otherwise it defaults to the project
 * session (`session` or the MCP default).
 */
export async function rememberAction(
  memory: Memory,
  { content, kind, session, scope }: RememberArgs,
): Promise<Record<string, unknown>> {
  // Readiness is enforced by the `withReady` wrapper at the MCP tool boundary (#104);
  // the CLI path that also calls this opens synchronously (no background rebuild).
  const sessionId =
    scope === 'global'
      ? getOrCreateGlobalSession(memory.store)
      : resolveSession(memory, session ?? DEFAULT_SESSION);
  const id = await memory.indexer.write({ sessionId, kind: kind ?? 'note', content });
  return { id, sessionId, scope: scope ?? 'project' };
}

/** Arguments accepted by {@link setSessionProjectAction}. */
export interface SetSessionProjectArgs {
  action: 'skip' | 'include';
  session?: string;
  confirmDelete?: boolean;
}

/**
 * Core of the `set_session_project` MCP tool (#52, F6), extracted for direct
 * testing. The project is always the session's folder (the cwd) — there is no name
 * to choose — so this only decides skip vs include. `include` clears a prior skip
 * binding (back to the default: stored under the folder); `skip` excludes the
 * session, gating the IRREVERSIBLE delete of already-stored observations behind
 * `confirmDelete` (the MCP analog of the CLI's `--yes`; ADR-0008). Session id comes
 * from `session` (preferred — the notice passes it) or, as a last resort, the
 * launching harness's env via {@link envSession} (#109 — claude-code reads
 * `CLAUDE_CODE_SESSION_ID`; payload-only harnesses resolve to nothing rather than
 * binding a stale Claude session). Read-only store lookups never mint a session row.
 */
export function setSessionProjectAction(
  memory: Memory,
  { action, session, confirmDelete }: SetSessionProjectArgs,
  harnessId?: string,
): Record<string, unknown> {
  const sid = session ?? envSession(harnessId);
  if (!sid) {
    return {
      error:
        'no session id — pass `session` (from the SessionStart notice) or set CLAUDE_CODE_SESSION_ID',
    };
  }

  if (action === 'include') {
    const cleared = clearBinding(memory.store, sid);
    return { session: sid, action: 'include', cleared, applied: true };
  }

  // skip — gate the IRREVERSIBLE delete of already-stored observations.
  const existing = memory.store.getSessionByExternalId(sid);
  const storedCount = existing
    ? memory.store.listObservations({ sessionId: existing.id }).length
    : 0;
  if (storedCount > 0 && confirmDelete !== true) {
    return {
      session: sid,
      action: 'skip',
      wouldDelete: storedCount,
      applied: false,
      message: `skip will HARD-DELETE ${storedCount} stored observation(s) for this session (IRREVERSIBLE — export first via 'abs export'). Re-call with confirmDelete=true to proceed.`,
    };
  }
  writeBinding(memory.store, sid, { action: 'skip' });
  return { session: sid, action: 'skip', deleted: storedCount, applied: true };
}

/** Result of the startup index gate, derived from the indexer (no extra import). */
type EnsureResult = Awaited<ReturnType<Memory['indexer']['ensureIndex']>>;

/**
 * Run the startup index gate as a NON-REJECTING promise: on failure it logs and
 * resolves to void (degraded — the store rows still serve), so callers that
 * `await memory.ready` never inherit a rejection. Without this, a one-off rebuild
 * error (e.g. an embed-provider hiccup) would make every later `recall`/`remember`
 * re-throw it — turning a degraded index into a persistent tool outage until
 * restart (Codex P1 on #76).
 */
export interface BackgroundEnsureContext {
  /** Persist the degraded signal on failure so SessionStart (#101) can surface it. */
  store: Pick<Memory['store'], 'setMeta' | 'deleteMeta'>;
  /** Db path whose sibling `.rebuild.lock` makes concurrent ingest hooks defer (#103). */
  dbPath: string;
  /** Caller-computed `indexer.status().stale`: only hold the lock when a rebuild will actually run. */
  willRebuild: boolean;
}

export async function backgroundEnsure(
  indexer: Pick<Memory['indexer'], 'ensureIndex'>,
  ctx?: BackgroundEnsureContext,
): Promise<EnsureResult | void> {
  // Hold the cross-process write lock ONLY when a rebuild is actually going to run
  // (status was stale). A no-op ensure must not make hooks defer for nothing.
  const lock = ctx?.willRebuild ? acquireRebuildLock(ctx.dbPath) : null;
  const heartbeat = lock ? setInterval(() => lock.heartbeat(), REBUILD_HEARTBEAT_MS) : null;
  heartbeat?.unref?.(); // don't keep the event loop alive for the heartbeat alone
  try {
    const result = await indexer.ensureIndex();
    // A clean ensure clears any stale degraded flag from a PRIOR failed rebuild, so
    // the SessionStart degraded note doesn't stick forever after one transient error.
    // F8-01: contain the metadata write — a throwing store must NOT break this
    // function's non-rejecting contract (that would surface as an unhandledRejection
    // and crash the long-lived MCP server).
    try {
      ctx?.store.deleteMeta(REBUILD_FAILED_KEY);
    } catch (metaErr) {
      process.stderr.write(`[abs] could not clear degraded flag: ${String(metaErr)}\n`);
    }
    return result;
  } catch (err) {
    // Degraded: record a DURABLE signal (not just stderr) so a later SessionStart
    // can tell the user recall is degraded — a swallowed error used to be invisible.
    // F8-01: the same containment — a setMeta failure here used to bubble out of the
    // catch as an unhandledRejection that could kill the server.
    try {
      ctx?.store.setMeta(REBUILD_FAILED_KEY, new Date().toISOString());
    } catch (metaErr) {
      process.stderr.write(`[abs] could not record degraded flag: ${String(metaErr)}\n`);
    }
    process.stderr.write(`[abs] background index rebuild failed: ${String(err)}\n`);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    lock?.release();
  }
}

/** Boot the full stack and serve it over stdio. Used by the CLI / MCP packaging. */
export async function startStdio(harnessId?: string): Promise<void> {
  // Open the stack WITHOUT the startup rebuild gate so the stdio `initialize`
  // handshake answers instantly. A slow rebuild here (a count-drift / signature
  // change re-embeds every observation, which can take seconds) would keep the
  // server from reading stdin, so `claude mcp list` probes time out as
  // "✗ Failed to connect" even though the server is healthy.
  const config = loadConfig();
  const memory = await openMemory(config, { ensure: false });
  // Bring the index up to date in the BACKGROUND; recall/remember await `ready` so
  // they never read or write a half-built index. `backgroundEnsure` never rejects,
  // so a rebuild failure stays non-fatal instead of poisoning every later call.
  // It holds the cross-process rebuild lock (only if a rebuild is actually due) so
  // a concurrent ingest hook defers gracefully instead of starving on busy_timeout,
  // and records a durable degraded flag if the rebuild fails (#103).
  memory.ready = backgroundEnsure(memory.indexer, {
    store: memory.store,
    dbPath: config.dbPath,
    willRebuild: memory.indexer.status().stale,
  });

  const server = createMcpServer(memory, harnessId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
