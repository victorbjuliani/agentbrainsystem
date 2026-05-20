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
import { type Memory, openMemory } from '../memory.js';
import { VERSION } from '../version.js';

/** Default external session id used when a `remember` call omits one. */
const DEFAULT_SESSION = 'mcp';

function jsonContent(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
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
      const existing = memory.store.getSessionByExternalId(externalId);
      const sessionId = existing?.id ?? memory.store.createSession({ externalId });
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

  return server;
}

/** Boot the full stack and serve it over stdio. Used by the CLI / MCP packaging. */
export async function startStdio(): Promise<void> {
  const memory = await openMemory();
  const server = createMcpServer(memory);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
