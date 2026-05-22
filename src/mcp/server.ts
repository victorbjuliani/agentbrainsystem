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
import { defaultClaudeProjectsDir, sanitizeProjectName, writeBinding } from '../ingest/index.js';
import { type Memory, openMemory } from '../memory.js';
import {
  applyApprovedCandidate,
  generateOptimizations,
  type OptimizeCandidate,
} from '../optimize/index.js';
import { VERSION } from '../version.js';

/** Default external session id used when a `remember` call omits one. */
const DEFAULT_SESSION = 'mcp';

function jsonContent(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
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

export function createMcpServer(memory: Memory): McpServer {
  const server = new McpServer({ name: 'agentbrainsystem', version: VERSION });

  server.registerTool(
    'recall',
    {
      title: 'Recall memories',
      description:
        'Hybrid semantic + keyword search over stored agent memory. Returns the most relevant past observations for a query.',
      inputSchema: {
        query: z.string().describe('What to search memory for.'),
        limit: z.number().int().positive().max(50).optional().describe('Max results (default 10).'),
      },
    },
    async ({ query, limit }) => {
      const hits = await memory.recall.recall(query, { limit });
      return jsonContent(
        hits.map((h) => ({
          id: h.observation.id,
          kind: h.observation.kind,
          content: h.observation.content,
          score: Number(h.score.toFixed(6)),
          vectorRank: h.vectorRank,
          ftsRank: h.ftsRank,
          createdAt: h.observation.createdAt,
        })),
      );
    },
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
      },
    },
    async ({ content, kind, session }) => {
      const externalId = session ?? DEFAULT_SESSION;
      const sessionId = resolveSession(memory, externalId);
      const id = await memory.indexer.write({ sessionId, kind: kind ?? 'note', content });
      return jsonContent({ id, sessionId });
    },
  );

  server.registerTool(
    'memory_status',
    {
      title: 'Memory status',
      description: 'Real index counts and staleness for the memory store.',
      inputSchema: {},
    },
    async () => jsonContent(memory.indexer.status()),
  );

  // Optimize loop (#21). `optimize` generates evidence-backed candidate diffs
  // (read-only); `apply` writes ONE of those candidates to disk through the gated
  // applier. The cache makes `apply` accept only candidates THIS server generated
  // — the agent cannot fabricate a diff/target — keeping the gated-apply trust
  // boundary (#20). The proactive flow is: agent reads the SessionStart staleness
  // flag → calls `optimize` → shows the diffs → the USER approves → agent calls
  // `apply` per approved id. `apply` never auto-writes: it is an explicit call and
  // the fail-closed user|feedback guard still refuses protected entries.
  const optimizeCache = new Map<string, { candidate: OptimizeCandidate; projectRoot: string }>();

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
    async ({ project, limit }) => {
      const projectRoot = project ?? process.cwd();
      const { candidates, estimate } = await generateOptimizations(memory, loadConfig(), {
        projectRoot,
        ...(limit !== undefined ? { limit } : {}),
      });
      optimizeCache.clear();
      for (const c of candidates) optimizeCache.set(c.id, { candidate: c, projectRoot });
      return jsonContent({
        candidates: candidates.map((c) => ({
          id: c.id,
          priority: c.priority,
          title: c.title,
          rationale: c.rationale,
          target: { kind: c.target.kind, path: c.target.absPath },
          evidenceIds: c.evidenceIds,
          diff: c.diff,
        })),
        estimate,
      });
    },
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
    async ({ candidateId }) => {
      const entry = optimizeCache.get(candidateId);
      if (!entry) {
        return jsonContent({
          error: `unknown candidate id '${candidateId}' — call optimize first to generate candidates`,
        });
      }
      const result = await applyApprovedCandidate(memory, entry.candidate, {
        projectRoot: entry.projectRoot,
        projectsDir: defaultClaudeProjectsDir(),
      });
      return jsonContent(result);
    },
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
    async ({ ids, session, project, nullProject, search, limit }) => {
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
    },
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
    async ({ handle }) => {
      try {
        const result = execute(memory, handle);
        return jsonContent(result);
      } catch (e) {
        if (e instanceof DeleteRefusalError) {
          return jsonContent({ error: e.message, reason: e.reason });
        }
        throw e;
      }
    },
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
      title: 'Set this session’s project',
      description:
        "Record which project the CURRENT session is filed under (or skip it), as the user chose. action='set' needs a project name (sanitized); action='skip' excludes the session from memory. Pass `session` (the id from the SessionStart picker); if omitted it falls back to CLAUDE_CODE_SESSION_ID, which MAY bind the wrong session if the server is shared. SKIP IS IRREVERSIBLE: it hard-deletes any already-stored observations for the session — that delete only runs with confirmDelete=true (export first via `abs export`); otherwise it returns a preview with the count.",
      inputSchema: {
        action: z
          .enum(['set', 'skip'])
          .describe("'set' to file under a project, 'skip' to exclude."),
        project: z.string().optional().describe("Project label (required for action='set')."),
        session: z
          .string()
          .optional()
          .describe(
            'The current session id (from the picker). Falls back to CLAUDE_CODE_SESSION_ID.',
          ),
        confirmDelete: z
          .boolean()
          .optional()
          .describe(
            'Required to confirm the IRREVERSIBLE hard-delete when skip would remove stored observations.',
          ),
      },
    },
    async (args) => jsonContent(setSessionProjectAction(memory, args)),
  );

  return server;
}

/** Arguments accepted by {@link setSessionProjectAction}. */
export interface SetSessionProjectArgs {
  action: 'set' | 'skip';
  project?: string;
  session?: string;
  confirmDelete?: boolean;
}

/**
 * Core of the `set_session_project` MCP tool (#52, F6), extracted for direct
 * testing. Mirrors `abs project` (#51): sanitize the label, write the binding,
 * and gate the IRREVERSIBLE skip-delete behind `confirmDelete` (the MCP analog of
 * the CLI's `--yes`; ADR-0008). Session id comes from `session` (preferred — the
 * picker passes it) or `CLAUDE_CODE_SESSION_ID` (last resort). Read-only store
 * lookups (`getSessionByExternalId`/`listObservations`) never mint a session row.
 */
export function setSessionProjectAction(
  memory: Memory,
  { action, project, session, confirmDelete }: SetSessionProjectArgs,
): Record<string, unknown> {
  const sid = session ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) {
    return {
      error:
        'no session id — pass `session` (from the SessionStart picker) or set CLAUDE_CODE_SESSION_ID',
    };
  }

  if (action === 'set') {
    if (project === undefined) {
      return { error: "action='set' requires a `project` name" };
    }
    const clean = sanitizeProjectName(project);
    if (clean === null) {
      return { error: `'${project}' is not a usable project name after sanitizing` };
    }
    const kind = memory.store.listProjects().includes(clean) ? 'existing' : 'new';
    writeBinding(memory.store, sid, { action: 'set', project: clean });
    return { session: sid, action: 'set', project: clean, kind, applied: true };
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

/** Boot the full stack and serve it over stdio. Used by the CLI / MCP packaging. */
export async function startStdio(): Promise<void> {
  const memory = await openMemory();
  const server = createMcpServer(memory);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
