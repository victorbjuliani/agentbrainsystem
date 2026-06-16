import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Memory } from '../memory.js';
import { MemoryStore } from '../store/index.js';

// F8-04: `realpathSync` can throw (broken symlink, symlink loop, a path raced away
// after the existsSync check) — `existsSync` and `realpathSync` both follow symlinks,
// so the only divergent case is a TOCTOU race, which is not reproducible without
// forcing the throw. Mock ONLY realpathSync (the rest of node:fs stays real) to prove
// serveStatic/serveIndex return 404 instead of crashing the server with an
// unhandledRejection. Isolated in its own file so the global mock can't reach the main
// UI server suite.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    realpathSync: () => {
      throw new Error('ELOOP: realpath failed');
    },
  };
});

import { createUiServer } from './server.js';

const DIM = 8;

function fakeMemory(store: MemoryStore): Memory {
  return { store } as unknown as Memory;
}

describe('UI server — realpathSync failure is contained per-request (F8-04)', () => {
  let dir: string;
  let store: MemoryStore;
  let server: ReturnType<typeof createUiServer>;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'abs-ui-realpath-'));
    // Real files so the existsSync (real) gate passes and the request reaches the
    // realpathSync call, which the mock makes throw.
    writeFileSync(join(dir, 'app.css'), 'body{}');
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    store = new MemoryStore({ dbPath: ':memory:', dimensions: DIM }).open();
    server = createUiServer(fakeMemory(store), { staticDir: dir });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serveStatic returns 404 (not a crash) when realpathSync throws', async () => {
    const r = await fetch(`${base}/app.css`);
    expect(r.status).toBe(404);
  });

  it('serveIndex returns 404 when realpathSync throws, and the server stays up', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(404);
    // The server survived the throw — a follow-up request still gets a response.
    const r2 = await fetch(`${base}/app.css`);
    expect(r2.status).toBe(404);
  });
});
