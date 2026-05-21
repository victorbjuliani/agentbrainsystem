/**
 * MCP server (issues #6 / #10) — exposes the memory over the Model Context
 * Protocol so Claude Code can recall and store memories as tools.
 *
 * Tools:
 *   - `recall`        — hybrid semantic + keyword search, returns ranked hits.
 *   - `remember`      — persist a new observation (index-at-write).
 *   - `memory_status` — real index counts + staleness (never cosmetic).
 *
 * `createMcpServer` builds the server from an open `Memory`; `startStdio` is the
 * process entrypoint the CLI/packaging launches over stdio.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { defaultClaudeProjectsDir } from '../ingest/index.js';
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

  return server;
}

/** Boot the full stack and serve it over stdio. Used by the CLI / MCP packaging. */
export async function startStdio(): Promise<void> {
  const memory = await openMemory();
  const server = createMcpServer(memory);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
