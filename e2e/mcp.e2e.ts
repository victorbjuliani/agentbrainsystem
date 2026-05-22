/**
 * E2E — MCP stdio surface against the BUILT binary (spawned exactly as Claude Code
 * would: `node dist/cli/cli.js start`). Covers:
 *   B  persistence across a process restart (ingest in one process, recall in another)
 *   D  tool contract (7 tools, recall/remember/memory_status shapes)
 *   E  forget two-phase (preview → handle → forget → single-use replay guard)
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abs, callTool, type E2EHome, FIXTURES_PROJECTS, makeHome, mcpClient } from './harness.js';

interface RecallHit {
  id: number;
  kind: string;
  content: string;
  score: number;
}
interface MemoryStatus {
  observations: number;
  vectors: number;
  fts: number;
  signature: string;
  expectedSignature: string;
  stale: boolean;
}
interface ForgetPreview {
  handle: string;
  count: number;
  items: Array<{ id: number; kind: string; snippet: string }>;
}

let h: E2EHome;
let client: Client | undefined;
beforeEach(() => {
  h = makeHome();
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  h.cleanup();
});

describe('B — persistence across a process restart', () => {
  it('content ingested by the CLI is recalled by a freshly spawned MCP server', async () => {
    // Process #1: ingest via the CLI (writes + persists the index to disk).
    const ing = await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
    expect(ing.code).toBe(0);

    // Process #2: a brand-new MCP server over the SAME ABS_HOME must recall it —
    // proving the index was persisted/rebuilt, not just held in the first process.
    client = await mcpClient(h.env);
    const hits = await callTool<RecallHit[]>(client, 'recall', {
      query: 'when is the staging database wiped',
      limit: 5,
    });
    expect(hits.some((x) => x.content.toLowerCase().includes('staging database'))).toBe(true);
  });
});

describe('D — MCP tool contract', () => {
  it('exposes exactly the 8 documented tools', async () => {
    client = await mcpClient(h.env);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'apply',
      'forget',
      'forget_preview',
      'memory_status',
      'optimize',
      'recall',
      'remember',
      'set_session_project',
    ]);
  });

  it('remember persists and recall retrieves it; memory_status reports real counts', async () => {
    client = await mcpClient(h.env);

    const before = await callTool<MemoryStatus>(client, 'memory_status', {});
    expect(before.observations).toBe(0);

    const saved = await callTool<{ id: number; sessionId: number }>(client, 'remember', {
      content: 'The deploy pipeline rotates secrets via Vault every 24 hours.',
      kind: 'note',
    });
    expect(saved.id).toBeGreaterThan(0);

    const hits = await callTool<RecallHit[]>(client, 'recall', {
      query: 'how are secrets rotated in the pipeline',
      limit: 3,
    });
    expect(hits.some((x) => x.content.includes('rotates secrets via Vault'))).toBe(true);

    const after = await callTool<MemoryStatus>(client, 'memory_status', {});
    expect(after.observations).toBe(before.observations + 1);
    expect(after.vectors).toBe(after.observations);
    expect(typeof after.signature).toBe('string');
    expect(after.stale).toBe(false);
  });
});

describe('E — forget two-phase (handle is single-use, TOCTOU-closed)', () => {
  it('preview mints a handle, forget deletes exactly that set, and replay is rejected', async () => {
    client = await mcpClient(h.env);

    for (const content of [
      'cache invalidation bug in the orders service',
      'cache warming runs on cold start of the workers',
      'unrelated note about the billing cron schedule',
    ]) {
      await callTool(client, 'remember', { content, kind: 'note' });
    }
    const start = await callTool<MemoryStatus>(client, 'memory_status', {});
    expect(start.observations).toBe(3);

    const preview = await callTool<ForgetPreview>(client, 'forget_preview', {
      search: 'cache',
      limit: 50,
    });
    expect(preview.count).toBeGreaterThanOrEqual(2);
    expect(preview.handle).toBeTruthy();

    const del = await callTool<{ deleted: number[]; notFound: number[] }>(client, 'forget', {
      handle: preview.handle,
    });
    expect(del.deleted.length).toBe(preview.count);

    const after = await callTool<MemoryStatus>(client, 'memory_status', {});
    expect(after.observations).toBe(start.observations - preview.count);

    // Replay the consumed handle → must be rejected, not delete anything again.
    const replay = await callTool<{ error?: string; reason?: string }>(client, 'forget', {
      handle: preview.handle,
    });
    expect(replay.reason).toBe('unknown-handle');
    const final = await callTool<MemoryStatus>(client, 'memory_status', {});
    expect(final.observations).toBe(after.observations);
  });
});
