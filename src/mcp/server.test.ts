import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { __clearDeleteCacheForTests } from '../delete/delete.js';
import type { EnsureResult } from '../indexer/index.js';
import { type Memory, openMemory } from '../memory.js';
import { createMcpServer, rememberAction } from './server.js';

let dir: string;
let mem: Memory;

function config(): AppConfig {
  return {
    dataDir: dir,
    dbPath: join(dir, 'memory.db'),
    embedding: { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384 },
    recallScope: 'global',
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
  // Store-wide recall by default for these tests; the project-isolation test passes
  // an explicit `project` arg so it is unaffected by this. (The recall handler reads
  // ABS_RECALL_SCOPE from the live env, not the test's config literal.)
  process.env.ABS_RECALL_SCOPE = 'global';
  mem = await openMemory(config());
  __clearDeleteCacheForTests();
});

afterEach(() => {
  mem.close();
  delete process.env.ABS_RECALL_SCOPE;
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('exposes recall, remember, memory_status, optimize, apply, forget_preview and forget tools', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'apply',
      'forget',
      'forget_preview',
      'memory_status',
      'optimize',
      'promote',
      'recall',
      'remember',
      'set_session_project',
    ]);
  });

  it('forget_preview returns a handle + count; forget(handle) deletes; replay → unknown-handle', async () => {
    const client = await connectedClient();
    const saved = parse(
      await client.callTool({
        name: 'remember',
        arguments: { content: 'ephemeral note to be forgotten', kind: 'note' },
      }),
    ) as { id: number };

    const prev = parse(
      await client.callTool({ name: 'forget_preview', arguments: { ids: [saved.id] } }),
    ) as { handle: string; count: number; items: Array<{ id: number }> };
    expect(prev.count).toBe(1);
    expect(typeof prev.handle).toBe('string');
    expect(prev.items[0]?.id).toBe(saved.id);

    const del = parse(
      await client.callTool({ name: 'forget', arguments: { handle: prev.handle } }),
    ) as {
      deleted: number[];
    };
    expect(del.deleted).toEqual([saved.id]);
    expect(mem.store.getObservation(saved.id)).toBeNull();

    // second forget(sameHandle) → consumed → unknown-handle.
    const replay = parse(
      await client.callTool({ name: 'forget', arguments: { handle: prev.handle } }),
    ) as { reason?: string };
    expect(replay.reason).toBe('unknown-handle');
  });

  it('forget(bogus handle) → unknown-handle (machine-readable, no throw)', async () => {
    const client = await connectedClient();
    const res = parse(
      await client.callTool({ name: 'forget', arguments: { handle: 'never-minted' } }),
    ) as { reason?: string };
    expect(res.reason).toBe('unknown-handle');
  });

  it('forget_preview rejects zero or multiple selectors', async () => {
    const client = await connectedClient();
    const none = parse(await client.callTool({ name: 'forget_preview', arguments: {} })) as {
      error?: string;
    };
    expect(none.error).toMatch(/exactly one selector/i);
    const many = parse(
      await client.callTool({
        name: 'forget_preview',
        arguments: { ids: [1], session: 2 },
      }),
    ) as { error?: string };
    expect(many.error).toMatch(/exactly one selector/i);
  });

  it('forget_preview rejects an empty ids array (parity with CLI/UI hard-error)', async () => {
    const client = await connectedClient();
    // `ids:[]` must NOT silently resolve to a count-0 no-op selector; the `.min(1)`
    // schema rejects it at the boundary the way CLI (`--ids requires at least one id`)
    // and the UI do. The MCP SDK surfaces a schema violation as an isError result.
    const res = (await client.callTool({
      name: 'forget_preview',
      arguments: { ids: [] },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/validation|too_small|>=1/i);
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

  it('recall honors an explicit project arg — no cross-project leak (#47)', async () => {
    // Seed two named projects with distinct content + vectors.
    for (const [ext, project, content] of [
      ['px', 'ProjX', 'ProjX: the refund window is 30 days.'],
      ['py', 'ProjY', 'ProjY: kubernetes ingress uses nginx with TLS.'],
    ] as const) {
      const sid = mem.store.createSession({ externalId: ext, project });
      const obs = mem.store.createObservation({ sessionId: sid, kind: 'note', content });
      mem.store.indexFts(obs, content);
      const [vec] = await mem.provider.embed([content]);
      mem.store.upsertVector(obs, vec as number[]);
    }
    const client = await connectedClient();

    const x = parse(
      await client.callTool({
        name: 'recall',
        arguments: { query: 'kubernetes ingress nginx tls', limit: 5, project: 'ProjX' },
      }),
    ) as Array<{ content: string }>;
    expect(x.some((h) => h.content.includes('kubernetes'))).toBe(false); // ProjY content excluded

    const y = parse(
      await client.callTool({
        name: 'recall',
        arguments: { query: 'kubernetes ingress nginx tls', limit: 5, project: 'ProjY' },
      }),
    ) as Array<{ content: string }>;
    expect(y.some((h) => h.content.includes('kubernetes'))).toBe(true);
  });

  it('optimize generates candidates and apply writes one to disk (CLAUDE.md path)', async () => {
    const projectRoot = join(dir, 'proj');
    const sessionId = mem.store.createSession({ externalId: 's1' });
    await mem.indexer.write({
      sessionId,
      kind: 'decision',
      content: 'Chose SQLite + sqlite-vec over a separate vector DB.',
      source: 'consolidate',
      metadata: { sourceSession: sessionId },
    });

    const client = await connectedClient();
    const gen = parse(
      await client.callTool({ name: 'optimize', arguments: { project: projectRoot } }),
    ) as { candidates: Array<{ id: string; target: { kind: string; path: string } }> };
    // The internal stale-content guard (baseContent) must NOT leak over MCP — only the
    // explicit review fields are serialized; the full candidate stays server-side.
    for (const c of gen.candidates) {
      expect(c).not.toHaveProperty('baseContent');
    }
    const claudeMd = gen.candidates.find((c) => c.target.kind === 'claude-md');
    expect(claudeMd).toBeDefined();
    if (!claudeMd) return;

    const applied = parse(
      await client.callTool({ name: 'apply', arguments: { candidateId: claudeMd.id } }),
    ) as { applied: boolean; absPath: string };
    expect(applied.applied).toBe(true);

    const { existsSync } = await import('node:fs');
    expect(existsSync(join(projectRoot, 'CLAUDE.md'))).toBe(true);
  });

  it('apply refuses an unknown candidate id (no prior optimize)', async () => {
    const client = await connectedClient();
    const res = parse(
      await client.callTool({ name: 'apply', arguments: { candidateId: 'cand-999' } }),
    ) as { error?: string };
    expect(res.error).toMatch(/unknown candidate/i);
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

describe('background startup rebuild (MCP boot latency)', () => {
  it('openMemory with ensure:false defers the startup index gate (fast boot)', async () => {
    // The MCP stdio server boots with ensure:false so the `initialize` handshake
    // answers before any rebuild — the gate result must NOT be computed eagerly.
    const m = await openMemory(config(), { ensure: false });
    try {
      expect(m.ensure).toBeUndefined();
    } finally {
      m.close();
    }
  });

  it('rememberAction parks on memory.ready and never writes a half-built index', async () => {
    // Simulate the boot path: a still-running background rebuild. The write must wait
    // for it. A non-gated write would land within these macrotasks regardless of how
    // fast embedding is — so a still-empty store after 50ms proves the gate holds.
    let resolveReady!: (r: EnsureResult) => void;
    mem.ready = new Promise<EnsureResult>((res) => {
      resolveReady = res;
    });

    let settled = false;
    const pending = rememberAction(mem, { content: 'gated write' }).then((v) => {
      settled = true;
      return v as { id: number };
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(mem.store.counts().observations).toBe(0);

    resolveReady({ rebuilt: false, reason: 'fresh', status: mem.indexer.status() });
    const out = await pending;
    expect(out.id).toBeGreaterThan(0);
    expect(mem.store.counts().observations).toBe(1);
  });
});
