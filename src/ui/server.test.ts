import { request } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { Memory } from '../memory.js';
import { Recall } from '../recall/index.js';
import { MemoryStore } from '../store/index.js';
import { NODE_CAP } from './graph.js';
import type { GraphData } from './graph-types.js';
import { GRAPH_CONTRACT_VERSION } from './graph-types.js';
import {
  __csrfTokenForTests,
  createUiServer,
  parseDeleteSelector,
  parseGraphQuery,
} from './server.js';

const DIM = 8;

// Built static dir (dist/ui/static) — tests run from src/ where no sibling exists.
const STATIC_DIR = resolve(fileURLToPath(new URL('../../dist/ui/static', import.meta.url)));

/** A Memory façade exposing only the read store the UI server touches. */
function fakeMemory(store: MemoryStore): Memory {
  return { store } as unknown as Memory;
}

describe('createUiServer (HTTP contract)', () => {
  let store: MemoryStore;
  let base: string;
  let server: ReturnType<typeof createUiServer>;

  beforeEach(async () => {
    store = new MemoryStore({ dbPath: ':memory:', dimensions: DIM }).open();
    const s = store.createSession({ externalId: 'sess', project: 'proj' });
    for (let i = 0; i < 3; i++) {
      store.createObservation({ sessionId: s, kind: 'user', content: `m${i}` });
    }
    server = createUiServer(fakeMemory(store), { staticDir: STATIC_DIR });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    store.close();
  });

  it('binds 127.0.0.1', () => {
    const addr = server.address();
    expect(addr && typeof addr === 'object' ? addr.address : '').toBe('127.0.0.1');
  });

  it('GET /api/graph returns valid GraphData with the contract version', async () => {
    const r = await fetch(`${base}/api/graph`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const data = (await r.json()) as GraphData;
    expect(data.version).toBe(GRAPH_CONTRACT_VERSION);
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
  });

  it('rejects non-GET methods with 405', async () => {
    const r = await fetch(`${base}/api/graph`, { method: 'POST' });
    expect(r.status).toBe(405);
  });

  it('GET /api/stats returns session and observation counts plus the high-water id', async () => {
    const r = await fetch(`${base}/api/stats`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const s = (await r.json()) as {
      sessions: number;
      observations: number;
      maxObservationId: number;
    };
    expect(s.sessions).toBe(1);
    expect(s.observations).toBe(3);
    expect(s.maxObservationId).toBe(3); // 3 observations created, monotonic ids 1..3
  });

  it('GET /api/stats?since= counts only observations newer than the cursor', async () => {
    const r = await fetch(`${base}/api/stats?since=1`);
    expect(r.status).toBe(200);
    const s = (await r.json()) as { newSince: number };
    expect(s.newSince).toBe(2); // ids 2 and 3 are > 1
  });

  it('GET /api/stats never leaks observation content (counts only — SEC)', async () => {
    const r = await fetch(`${base}/api/stats`);
    const body = await r.text();
    expect(body).not.toContain('m0');
    expect(body).not.toContain('m1');
    expect(body).not.toContain('m2');
  });

  it('rejects non-GET on /api/stats with 405', async () => {
    const r = await fetch(`${base}/api/stats`, { method: 'POST' });
    expect(r.status).toBe(405);
  });

  it('never escapes the static dir on path traversal attempts', async () => {
    for (const path of [
      '/static/..%2f..%2fetc%2fpasswd',
      '/static/../../package.json',
      '/static/..%2f..%2fpackage.json',
    ]) {
      const r = await fetch(`${base}${path}`);
      // never 200 with file contents; 403 (blocked) or 404 (no such asset).
      expect([403, 404]).toContain(r.status);
    }
  });

  it('a huge ?limit cannot force more than NODE_CAP nodes', async () => {
    const r = await fetch(`${base}/api/graph?limit=1000000`);
    const data = (await r.json()) as GraphData;
    expect(data.nodes.length).toBeLessThanOrEqual(NODE_CAP);
    expect(data.scope.limit).toBe(NODE_CAP);
  });

  it('returns 404 for an unknown path', async () => {
    const r = await fetch(`${base}/nope`);
    expect(r.status).toBe(404);
  });

  it('serves / templated HTML with a fresh CSRF token (no longer serveStatic)', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const html = await r.text();
    // The placeholder is substituted with the live token; the raw placeholder is gone.
    expect(html).not.toContain('__ABS_CSRF__');
    expect(html).toContain(`content="${__csrfTokenForTests()}"`);
  });

  it('serves / with defence-in-depth security headers (SEC-02)', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  });
});

// --- Graph query parsing (#35) ----------------------------------------------

describe('parseGraphQuery', () => {
  const parse = (qs: string) => parseGraphQuery(new URLSearchParams(qs));

  it('parses session/topN/limit/similarity', () => {
    expect(parse('session=7')).toEqual({ session: 7 });
    expect(parse('topN=200')).toEqual({ topN: 200 });
    expect(parse('limit=50')).toEqual({ limit: 50 });
    expect(parse('similarity=1')).toEqual({ similarity: true });
  });

  it('reads a non-empty search param (#35)', () => {
    expect(parse('search=unicorn')).toEqual({ search: 'unicorn' });
    expect(parse('search=hello%20world')).toEqual({ search: 'hello world' });
  });

  it('drops an empty / whitespace-only search so it never shadows the scope', () => {
    expect(parse('search=').search).toBeUndefined();
    expect(parse('search=%20%20').search).toBeUndefined();
    expect(parse('topN=200&search=')).toEqual({ topN: 200 });
  });

  it('reads a non-empty project param and composes with topN', () => {
    expect(parse('project=alpha')).toEqual({ project: 'alpha' });
    expect(parse('topN=200&project=-Users-vbjuliani-Devs-ChessDNA')).toEqual({
      topN: 200,
      project: '-Users-vbjuliani-Devs-ChessDNA',
    });
  });

  it('drops an empty / whitespace-only project', () => {
    expect(parse('project=').project).toBeUndefined();
    expect(parse('project=%20').project).toBeUndefined();
  });
});

// --- Selector parsing (ADR-0007 query-string contract) ----------------------

describe('parseDeleteSelector', () => {
  const parse = (qs: string) => parseDeleteSelector(new URLSearchParams(qs));

  it('maps each shape to the core DeleteSelector', () => {
    expect(parse('sel=ids&ids=3,1,2,1')).toEqual({ byIds: [3, 1, 2] }); // deduped, order kept
    expect(parse('sel=session&id=5')).toEqual({ bySession: 5 });
    expect(parse('sel=project&project=alpha')).toEqual({ byProject: 'alpha' });
    expect(parse('sel=null-project')).toEqual({ byProject: null });
    expect(parse('sel=search&q=hello&limit=8')).toEqual({ bySearch: { query: 'hello', limit: 8 } });
    expect(parse('sel=search&q=hello')).toEqual({ bySearch: { query: 'hello' } });
  });

  it('rejects malformed / non-positive numeric inputs', () => {
    expect(() => parse('sel=ids&ids=1,-2')).toThrow();
    expect(() => parse('sel=ids&ids=0')).toThrow();
    expect(() => parse('sel=ids&ids=abc')).toThrow();
    expect(() => parse('sel=ids')).toThrow();
    expect(() => parse('sel=session&id=0')).toThrow();
    expect(() => parse('sel=project')).toThrow();
    expect(() => parse('sel=search')).toThrow();
    expect(() => parse('sel=bogus')).toThrow();
    expect(() => parse('')).toThrow();
  });

  it('rejects a byIds selector that exceeds the cardinality cap (SEC-01)', () => {
    // 10_001 ids → over the 10_000 cap → SelectorError (→ 400), never a resolve.
    const tooMany = Array.from({ length: 10_001 }, (_, i) => i + 1).join(',');
    expect(() => parse(`sel=ids&ids=${tooMany}`)).toThrow(/cap/);
    // exactly at the cap is accepted.
    const atCap = Array.from({ length: 10_000 }, (_, i) => i + 1).join(',');
    expect(() => parse(`sel=ids&ids=${atCap}`)).not.toThrow();
  });
});

// --- Write path: the four security controls (ADR-0007, Gate 0b) -------------

class NoopEmbedding implements EmbeddingProvider {
  readonly id = 'noop';
  readonly model = 'noop-v1';
  readonly dimensions = DIM;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array<number>(DIM).fill(0));
  }
}

/** A Memory façade with the read store + recall the delete core touches. */
function deleteMemory(store: MemoryStore): Memory {
  return { store, recall: new Recall(store, new NoopEmbedding()) } as unknown as Memory;
}

/**
 * Raw HTTP request with FULL control over headers — `fetch` (undici) silently drops
 * a forbidden `Host` header, so the Host-allowlist test must use `node:http`.
 */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((res, rej) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers }, (resp) => {
      resp.resume();
      resp.on('end', () => res(resp.statusCode ?? 0));
    });
    r.on('error', rej);
    r.end();
  });
}

describe('delete write path (4 controls)', () => {
  let store: MemoryStore;
  let server: ReturnType<typeof createUiServer>;
  let port: number;
  let base: string;
  let session: number;
  const token = __csrfTokenForTests();

  const goodHeaders = (): Record<string, string> => ({ 'X-ABS-CSRF': token });

  beforeEach(async () => {
    store = new MemoryStore({ dbPath: ':memory:', dimensions: DIM }).open();
    session = store.createSession({ externalId: 'sess', project: 'proj' });
    for (let i = 0; i < 4; i++) {
      store.createObservation({ sessionId: session, kind: 'user', content: `m${i}` });
    }
    server = createUiServer(deleteMemory(store), { staticDir: STATIC_DIR });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const addr = server.address();
    port = addr && typeof addr === 'object' ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    store.close();
  });

  // Control 1 — method gate -------------------------------------------------
  it('GET on a delete route → 405; other non-GET still 405', async () => {
    expect((await fetch(`${base}/api/delete/preview?sel=session&id=${session}`)).status).toBe(405);
    expect((await fetch(`${base}/api/delete?handle=x`)).status).toBe(405);
    // Every OTHER route stays GET-only.
    expect((await fetch(`${base}/api/graph`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/nope`, { method: 'PUT' })).status).toBe(405);
    // The preview route rejects a DELETE, and the execute route rejects a POST.
    expect(
      (await fetch(`${base}/api/delete/preview`, { method: 'DELETE', headers: goodHeaders() }))
        .status,
    ).toBe(405);
    expect(
      (await fetch(`${base}/api/delete`, { method: 'POST', headers: goodHeaders() })).status,
    ).toBe(405);
  });

  // Control 3 — CSRF token --------------------------------------------------
  it('delete route without / with wrong CSRF token → 403', async () => {
    const url = `${base}/api/delete/preview?sel=session&id=${session}`;
    expect((await fetch(url, { method: 'POST' })).status).toBe(403); // absent
    expect((await fetch(url, { method: 'POST', headers: { 'X-ABS-CSRF': 'nope' } })).status).toBe(
      403,
    ); // wrong
  });

  // Control 2 — Host / Origin allowlist -------------------------------------
  it('wrong-port Host → 403; foreign Origin → 403; correct → pass', async () => {
    const path = `/api/delete/preview?sel=session&id=${session}`;
    // Wrong port in Host (anti DNS-rebinding) — keyed on req.socket.localPort.
    expect(await rawRequest(port, 'POST', path, { ...goodHeaders(), Host: '127.0.0.1:1' })).toBe(
      403,
    );
    // Wrong hostname in Host (a rebind target).
    expect(
      await rawRequest(port, 'POST', path, { ...goodHeaders(), Host: `evil.example:${port}` }),
    ).toBe(403);
    // Foreign Origin (anti cross-site) with a correct Host.
    expect(
      await rawRequest(port, 'POST', path, {
        ...goodHeaders(),
        Host: `127.0.0.1:${port}`,
        Origin: 'http://evil.example',
      }),
    ).toBe(403);
    // Correct Host + Origin + token → passes (200).
    expect(
      await rawRequest(port, 'POST', path, {
        ...goodHeaders(),
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
      }),
    ).toBe(200);
  });

  // Happy path + Control 4 (server-side handle confirmation) -----------------
  it('preview → execute deletes exactly the previewed set', async () => {
    const pv = await fetch(`${base}/api/delete/preview?sel=session&id=${session}`, {
      method: 'POST',
      headers: goodHeaders(),
    });
    expect(pv.status).toBe(200);
    const preview = (await pv.json()) as { handle: string; count: number; items: unknown[] };
    expect(preview.count).toBe(4);
    expect(preview.items).toHaveLength(4);

    const del = await fetch(`${base}/api/delete?handle=${preview.handle}`, {
      method: 'DELETE',
      headers: goodHeaders(),
    });
    expect(del.status).toBe(200);
    const result = (await del.json()) as { deleted: number[] };
    expect(result.deleted).toHaveLength(4);
    expect(store.listObservations({ sessionId: session })).toHaveLength(0);
  });

  it('unknown / replayed handle → clean 409 JSON, never a 500 (Control 4)', async () => {
    const pv = await fetch(`${base}/api/delete/preview?sel=ids&ids=1,2`, {
      method: 'POST',
      headers: goodHeaders(),
    });
    const { handle } = (await pv.json()) as { handle: string };

    // First execute consumes the handle.
    expect(
      (
        await fetch(`${base}/api/delete?handle=${handle}`, {
          method: 'DELETE',
          headers: goodHeaders(),
        })
      ).status,
    ).toBe(200);
    // Replay → 409 unknown-handle (consumed), not a 500.
    const replay = await fetch(`${base}/api/delete?handle=${handle}`, {
      method: 'DELETE',
      headers: goodHeaders(),
    });
    expect(replay.status).toBe(409);
    const body = (await replay.json()) as { reason: string };
    expect(body.reason).toBe('unknown-handle');
  });

  it('a malformed selector → 400, never a 500', async () => {
    const r = await fetch(`${base}/api/delete/preview?sel=ids&ids=-1`, {
      method: 'POST',
      headers: goodHeaders(),
    });
    expect(r.status).toBe(400);
  });
});

// --- SEC-03: an unexpected core fault → generic 500 (no detail leak) ----------

/** A store whose `getObservation` blows up with a detail-bearing message. */
function explodingStore(): MemoryStore {
  return {
    getObservation() {
      throw new Error('SECRET internal path /Users/secret/db.sqlite');
    },
  } as unknown as MemoryStore;
}

describe('SEC-03 — generic 500 body', () => {
  let server: ReturnType<typeof createUiServer>;
  let base: string;
  const token = __csrfTokenForTests();
  let stderr: string;
  let restore: (() => void) | undefined;

  beforeEach(async () => {
    // Capture stderr so the deliberate fault log doesn't pollute test output, and so
    // we can assert the detail IS logged server-side (just never sent to the client).
    stderr = '';
    const original = process.stderr.write.bind(process.stderr);
    const spy = (chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    };
    process.stderr.write = spy as typeof process.stderr.write;
    restore = () => {
      process.stderr.write = original;
    };

    server = createUiServer(fakeMemory(explodingStore()), { staticDir: STATIC_DIR });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    restore?.();
  });

  it('an unexpected fault in preview → 500 with a generic body, detail only on stderr', async () => {
    const r = await fetch(`${base}/api/delete/preview?sel=ids&ids=1`, {
      method: 'POST', // POST is the preview method
      headers: { 'X-ABS-CSRF': token },
    });
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('internal error');
    // The client body must NOT carry the internal detail …
    expect(JSON.stringify(body)).not.toContain('SECRET internal path');
    // … but it IS logged server-side for the operator.
    expect(stderr).toContain('SECRET internal path');
  });
});
