import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import { __clearDeleteCacheForTests } from '../delete/delete.js';
import type { EnsureResult } from '../indexer/index.js';
import { readBinding } from '../ingest/index.js';
import { type Memory, openMemory } from '../memory.js';
import { projectSlug } from '../optimize/targets.js';
import { isRebuildLocked, REBUILD_FAILED_KEY, rebuildLockPath } from '../store/index.js';
import { backgroundEnsure, createMcpServer, setSessionProjectAction, withReady } from './server.js';

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

  it('promote (no as) MOVES the whole observation into the global brain', async () => {
    const sid = mem.store.createSession({ externalId: 'pmv', project: '-Users-me-Devs-mv' });
    const id = mem.store.createObservation({
      sessionId: sid,
      kind: 'decision',
      content: 'turborepo',
    });
    mem.store.indexFts(id, 'turborepo');
    const client = await connectedClient();

    const res = parse(await client.callTool({ name: 'promote', arguments: { id } })) as {
      id: number;
      scope: string;
      applied: boolean;
      curated?: boolean;
    };
    expect(res).toMatchObject({ id, scope: 'global', applied: true });
    expect(res.curated).toBeUndefined();
    const g = mem.store.getSessionByExternalId('__global__');
    expect(mem.store.getObservation(id)?.sessionId).toBe(g?.id);
  });

  it('promote with `as` files a curated COPY and keeps the original intact', async () => {
    const sid = mem.store.createSession({ externalId: 'pcur', project: '-Users-me-Devs-cur' });
    const id = mem.store.createObservation({
      sessionId: sid,
      kind: 'decision',
      content: 'use JWT; secret HUNTER2 lives in /proj/vault',
    });
    mem.store.indexFts(id, 'use JWT; secret HUNTER2 lives in /proj/vault');
    const client = await connectedClient();

    const res = parse(
      await client.callTool({
        name: 'promote',
        arguments: { id, as: 'prefer JWT for stateless auth' },
      }),
    ) as { id: number; newId: number; scope: string; curated: boolean; applied: boolean };
    expect(res).toMatchObject({ id, scope: 'global', curated: true, applied: true });
    expect(res.newId).toBeGreaterThan(0);

    // original untouched in its project; curated copy is global with exactly the text
    expect(mem.store.getObservation(id)?.sessionId).toBe(sid);
    const g = mem.store.getSessionByExternalId('__global__');
    const created = mem.store.getObservation(res.newId);
    expect(created?.sessionId).toBe(g?.id);
    expect(created?.content).toBe('prefer JWT for stateless auth');
    expect(created?.content).not.toContain('HUNTER2');
    expect(created?.metadata).toMatchObject({ promotedFrom: id });
  });

  it('promote with empty `as` is rejected (no mutation)', async () => {
    const sid = mem.store.createSession({ externalId: 'pe', project: '-Users-me-Devs-pe' });
    const id = mem.store.createObservation({ sessionId: sid, kind: 'note', content: 'x' });
    const client = await connectedClient();

    const res = parse(await client.callTool({ name: 'promote', arguments: { id, as: '   ' } })) as {
      error?: string;
    };
    expect(res.error).toMatch(/non-empty|must not be empty/i);
    expect(mem.store.getObservation(id)?.sessionId).toBe(sid);
    // No mutation on invalid input: the reserved global session must NOT have been
    // minted by a rejected request (it would skew status/listing). (codex PR review)
    expect(mem.store.getSessionByExternalId('__global__')).toBeNull();
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
    // optimize is project-scoped (#135): seed the consolidated decision under the same
    // project label the optimize tool resolves projectRoot to, else 0 candidates.
    const sessionId = mem.store.createSession({
      externalId: 's1',
      project: projectSlug(projectRoot),
    });
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

    // With a NON-empty cache, an unrecognized id is a genuinely unknown candidate
    // (not a restart) — the message says so, distinct from the empty-cache case (#114).
    const unknown = parse(
      await client.callTool({ name: 'apply', arguments: { candidateId: 'cand-does-not-exist' } }),
    ) as { error?: string };
    expect(unknown.error).toMatch(/unknown candidate id/i);
    expect(unknown.error).toMatch(/not among the current candidates/i);

    const applied = parse(
      await client.callTool({ name: 'apply', arguments: { candidateId: claudeMd.id } }),
    ) as { applied: boolean; absPath: string };
    expect(applied.applied).toBe(true);

    const { existsSync } = await import('node:fs');
    expect(existsSync(join(projectRoot, 'CLAUDE.md'))).toBe(true);
  });

  it('apply on a fresh server (empty cache) explains both causes, not just restart (#114)', async () => {
    // No `optimize` ran on THIS server → the in-memory candidate cache is empty.
    // That has two innocent causes (a zero-candidate optimize OR a restart), so the
    // message must name BOTH, not assert a restart (Codex P2 on #128).
    const client = await connectedClient();
    const res = parse(
      await client.callTool({ name: 'apply', arguments: { candidateId: 'cand-999' } }),
    ) as { error?: string };
    expect(res.error).toMatch(/not loaded/i);
    expect(res.error).toMatch(/produced none/i); // the zero-candidate cause
    expect(res.error).toMatch(/restart/i); // the restart cause
    expect(res.error).toMatch(/re-run `optimize`/i);
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

  it('the remember TOOL parks on memory.ready and never writes a half-built index (#104)', async () => {
    // The readiness contract now lives in `withReady` at the tool boundary, not in
    // rememberAction itself. Simulate the boot path: a still-running background
    // rebuild. A non-gated write would land within these macrotasks regardless of how
    // fast embedding is — so a still-empty store after 50ms proves the gate holds.
    let resolveReady!: (r: EnsureResult) => void;
    mem.ready = new Promise<EnsureResult>((res) => {
      resolveReady = res;
    });
    const client = await connectedClient();

    let settled = false;
    const pending = client
      .callTool({ name: 'remember', arguments: { content: 'gated write' } })
      .then((v) => {
        settled = true;
        return v;
      });

    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(mem.store.counts().observations).toBe(0);

    resolveReady({ rebuilt: false, reason: 'fresh', status: mem.indexer.status() });
    await pending;
    expect(mem.store.counts().observations).toBe(1);
  });

  it('backgroundEnsure resolves on rebuild failure (never poisons memory.ready)', async () => {
    // A rejected ensureIndex must NOT propagate: callers await memory.ready, so a
    // rejection would turn a one-off rebuild error into a persistent tool outage.
    const failing = {
      ensureIndex: () => Promise.reject(new Error('embed provider down')),
    };
    await expect(backgroundEnsure(failing)).resolves.toBeUndefined();
  });

  it('backgroundEnsure forwards the result on success', async () => {
    const ok = await backgroundEnsure(mem.indexer);
    expect(ok).toMatchObject({ reason: expect.any(String) });
  });

  it('persists a durable degraded flag on failure and releases the lock (#103)', async () => {
    const failing = {
      ensureIndex: () => Promise.reject(new Error('embed provider down')),
    };
    await backgroundEnsure(failing, {
      store: mem.store,
      dbPath: config().dbPath,
      willRebuild: true,
    });
    expect(mem.store.getMeta(REBUILD_FAILED_KEY)).not.toBeNull();
    // The lock is released even on the failure path.
    expect(isRebuildLocked(config().dbPath)).toBe(false);
  });

  it('clears a stale degraded flag on a successful ensure (#103)', async () => {
    mem.store.setMeta(REBUILD_FAILED_KEY, '2026-01-01T00:00:00.000Z');
    await backgroundEnsure(mem.indexer, {
      store: mem.store,
      dbPath: config().dbPath,
      willRebuild: false,
    });
    expect(mem.store.getMeta(REBUILD_FAILED_KEY)).toBeNull();
  });

  it('holds the rebuild lock DURING a rebuild, releases after (#103)', async () => {
    let lockedDuring = false;
    const stub = {
      ensureIndex: async () => {
        lockedDuring = isRebuildLocked(config().dbPath);
        return {
          rebuilt: true,
          reason: 'count-drift',
          status: mem.indexer.status(),
        } as EnsureResult;
      },
    };
    await backgroundEnsure(stub, { store: mem.store, dbPath: config().dbPath, willRebuild: true });
    expect(lockedDuring).toBe(true);
    expect(isRebuildLocked(config().dbPath)).toBe(false);
  });

  it('does NOT take the lock when no rebuild is due (willRebuild=false) (#103)', async () => {
    await backgroundEnsure(mem.indexer, {
      store: mem.store,
      dbPath: config().dbPath,
      willRebuild: false,
    });
    expect(existsSync(rebuildLockPath(config().dbPath))).toBe(false);
  });
});

describe('setSessionProjectAction — single-prefix guard (R4, #67)', () => {
  it('writes the binding under EXACTLY the opaque session id — no double-prefix', () => {
    const res = setSessionProjectAction(mem, {
      action: 'skip',
      session: 'codex:abc',
      confirmDelete: true,
    });
    expect(res.applied).toBe(true);
    // The binding key is session-project:codex:abc, never session-project:codex:codex:abc.
    expect(readBinding(mem.store, 'codex:abc')?.action).toBe('skip');
    expect(readBinding(mem.store, 'codex:codex:abc')).toBeNull();
  });
});

describe('withReady — single rebuild-readiness contract (#104)', () => {
  it('runs fn immediately when memory.ready is undefined (synchronous/CLI path)', async () => {
    let ran = false;
    const out = await withReady({ ready: undefined }, async () => {
      ran = true;
      return 42;
    });
    expect(ran).toBe(true);
    expect(out).toBe(42);
  });

  it('defers fn until memory.ready resolves', async () => {
    const order: string[] = [];
    let resolve!: () => void;
    const ready = new Promise<void>((r) => {
      resolve = () => {
        order.push('ready');
        r();
      };
    });
    const p = withReady({ ready }, async () => {
      order.push('fn');
    });
    // fn must NOT have run yet — ready is still pending.
    await Promise.resolve();
    expect(order).toEqual([]);
    resolve();
    await p;
    expect(order).toEqual(['ready', 'fn']);
  });
});

describe('MCP tools wait for memory.ready before touching the index (#104)', () => {
  it('memory_status (a newly-wrapped tool) does not read the index until ready resolves', async () => {
    let resolveReady!: () => void;
    mem.ready = new Promise<void>((r) => {
      resolveReady = () => r();
    });
    const spy = vi.spyOn(mem.indexer, 'status');
    const client = await connectedClient();

    const callP = client.callTool({ name: 'memory_status', arguments: {} });
    // Let microtasks/timers flush: the handler must still be parked on `ready`.
    await new Promise((r) => setTimeout(r, 25));
    expect(spy).not.toHaveBeenCalled();

    resolveReady();
    await callP;
    expect(spy).toHaveBeenCalled();
  });
});
