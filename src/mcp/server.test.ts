import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { type Memory, openMemory } from '../memory.js';
import { createMcpServer } from './server.js';

let dir: string;
let mem: Memory;

function config(): AppConfig {
  return {
    dataDir: dir,
    dbPath: join(dir, 'memory.db'),
    embedding: { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384 },
  };
}

/** Wire an in-process MCP client to the server over a linked transport pair. */
async function connectedClient(): Promise<Client> {
  const server = createMcpServer(mem);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return client;
}

function parse(result: unknown): unknown {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0]?.text ?? 'null');
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'abs-mcp-'));
  mem = await openMemory(config());
});

afterEach(() => {
  mem.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('exposes recall, remember and memory_status tools', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['memory_status', 'recall', 'remember']);
  });

  it('remember persists and recall finds it via MCP', async () => {
    const client = await connectedClient();

    const saved = parse(
      await client.callTool({
        name: 'remember',
        arguments: {
          content: 'Deploy runs on Fridays only after the smoke suite passes.',
          kind: 'decision',
        },
      }),
    ) as { id: number };
    expect(saved.id).toBeGreaterThan(0);

    const hits = parse(
      await client.callTool({
        name: 'recall',
        arguments: { query: 'when do deploys happen', limit: 3 },
      }),
    ) as Array<{ id: number; content: string }>;
    expect(hits.some((h) => h.content.includes('Fridays'))).toBe(true);
  });

  it('memory_status reports real counts', async () => {
    const client = await connectedClient();
    await client.callTool({ name: 'remember', arguments: { content: 'one' } });
    await client.callTool({ name: 'remember', arguments: { content: 'two' } });

    const status = parse(await client.callTool({ name: 'memory_status', arguments: {} })) as {
      observations: number;
      vectors: number;
      fts: number;
      stale: boolean;
    };
    expect(status).toMatchObject({ observations: 2, vectors: 2, fts: 2, stale: false });
  });
});
