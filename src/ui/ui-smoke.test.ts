import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { Memory } from '../memory.js';
import { openMemory } from '../memory.js';
import { startUiServer } from './server.js';

// Ephemeral in-memory store config — note ':memory:' must be passed as the dbPath
// directly (config.loadConfig would path.resolve an ABS_DB_PATH into a real file).
const MEMORY_CONFIG: AppConfig = {
  dataDir: '.',
  dbPath: ':memory:',
  embedding: { provider: 'local', model: 'test', dimensions: 8 },
  recallScope: 'global',
};

// Built static dir (dist/ui/static); the smoke test serves real index.html from it.
const STATIC_DIR = resolve(fileURLToPath(new URL('../../dist/ui/static', import.meta.url)));

describe('UI smoke (startUiServer end-to-end)', () => {
  let memory: Memory;
  const closers: Array<() => Promise<void> | void> = [];

  beforeEach(async () => {
    // ensure:false → the factory builds a provider but no embedder/model loads.
    memory = await openMemory(MEMORY_CONFIG, { ensure: false });
    const s = memory.store.createSession({ externalId: 'sess', project: 'proj' });
    memory.store.createObservation({ sessionId: s, kind: 'user', content: 'hi' });
  });

  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
    memory.close();
  });

  it('listens and answers GET / and GET /api/graph with 200', async () => {
    const { server, url, port } = await startUiServer(memory, { staticDir: STATIC_DIR });
    closers.push(() => new Promise<void>((res) => server.close(() => res())));
    expect(port).toBeGreaterThan(0);

    const root = await fetch(`${url}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');

    // The served markup carries both feedback channels for the delete write path:
    // an assertive error banner and a polite aria-live status region (ADR-0008 a11y).
    const html = await root.text();
    expect(html).toContain('id="error-banner"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('id="status-banner"');
    expect(html).toContain('aria-live="polite"');

    const graph = await fetch(`${url}/api/graph`);
    expect(graph.status).toBe(200);
  });

  it('falls back to a different port when the preferred one is occupied', async () => {
    // Occupy a port, then ask startUiServer to start there → it should pick port+1.
    const blocker = createServer(() => {});
    const blockedPort = await new Promise<number>((res) => {
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address();
        res(addr && typeof addr === 'object' ? addr.port : 0);
      });
    });
    closers.push(() => new Promise<void>((res) => blocker.close(() => res())));

    const { server, port } = await startUiServer(memory, {
      port: blockedPort,
      staticDir: STATIC_DIR,
    });
    closers.push(() => new Promise<void>((res) => server.close(() => res())));
    expect(port).not.toBe(blockedPort);
    expect(port).toBeGreaterThan(blockedPort);
  });
});
