import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Memory } from '../memory.js';
import { MemoryStore } from '../store/index.js';
import { NODE_CAP } from './graph.js';
import type { GraphData } from './graph-types.js';
import { GRAPH_CONTRACT_VERSION } from './graph-types.js';
import { createUiServer } from './server.js';

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
});
