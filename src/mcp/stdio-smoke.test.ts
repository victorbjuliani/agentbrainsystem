import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * #10 smoke: spawn the packaged MCP server exactly as Claude Code would
 * (`abs start` over stdio) and prove a client can remember + recall through it.
 * Runs the TS entry via tsx so it needs no prior build; uses an isolated temp
 * ABS_HOME so the real user store is never touched.
 */
let dir: string;
let client: Client;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-stdio-'));
});

afterEach(async () => {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP stdio packaging', () => {
  it('Claude Code can spawn the server and call recall over stdio', async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', resolve('src/cli/cli.ts'), 'start'],
      // Store-wide recall: the smoke seeds via `remember` (NULL-project) and recalls
      // it back; the default project scope would filter that out.
      env: { ...process.env, ABS_HOME: dir, ABS_RECALL_SCOPE: 'global' },
    });
    client = new Client({ name: 'smoke', version: '0.0.0' });
    await client.connect(transport);

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

    await client.callTool({
      name: 'remember',
      arguments: { content: 'The staging database is reset every night at 2am UTC.', kind: 'note' },
    });

    const res = (await client.callTool({
      name: 'recall',
      arguments: { query: 'when is staging wiped', limit: 3 },
    })) as { content: Array<{ type: string; text: string }> };
    const hits = JSON.parse(res.content[0]?.text ?? '[]') as Array<{ content: string }>;
    expect(hits.some((h) => h.content.includes('staging database'))).toBe(true);

    // set_session_project (#52) over the real stdio transport: a skip binding round-trips.
    const skipRes = (await client.callTool({
      name: 'set_session_project',
      arguments: { action: 'skip', session: 'smoke-sess' },
    })) as { content: Array<{ type: string; text: string }> };
    const skipOut = JSON.parse(skipRes.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(skipOut).toMatchObject({
      session: 'smoke-sess',
      action: 'skip',
      applied: true,
    });
  });
});
