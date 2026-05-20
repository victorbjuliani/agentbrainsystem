/**
 * The localhost read-only memory-graph HTTP server (issue #11).
 *
 * Security posture (read-only, single-user, no auth):
 *   - Binds 127.0.0.1 ONLY — never 0.0.0.0. The graph is never exposed to the LAN.
 *   - GET-only. Any other method → 405. There is NO write path: no MemoryStore
 *     write method is imported or reachable from this module.
 *   - Static serving is allowlisted by extension and guarded against path
 *     traversal: the resolved realpath must stay UNDER the static dir, else 403.
 *   - The static dir is resolved via `import.meta.url` (NOT process.cwd()), so it
 *     works regardless of where the process was launched from. It lives at
 *     `../ui/static` relative to the compiled `dist/ui/server.js` → `dist/ui/static`.
 */

import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Memory } from '../memory.js';
import { buildGraph } from './graph.js';
import type { GraphQuery } from './graph-types.js';

/** Default localhost port; falls back to the next free port on EADDRINUSE. */
export const DEFAULT_UI_PORT = 7717;
const MAX_PORT_ATTEMPTS = 10;
const HOST = '127.0.0.1';

/** Allowlisted static extensions → content types. Anything else is not served. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface UiServerOptions {
  /** Preferred port; defaults to DEFAULT_UI_PORT. Falls back on EADDRINUSE. */
  port?: number;
  /**
   * Override the static asset directory. Production never sets this — the dir is
   * resolved from `import.meta.url` (dist/ui/static). Tests point it at the built
   * bundle since they run from `src/ui/` where no sibling `static/` exists.
   */
  staticDir?: string;
}

/** Absolute path to the bundled static dir (dist/ui/static), via import.meta.url. */
function defaultStaticDir(): string {
  return resolve(fileURLToPath(new URL('./static', import.meta.url)));
}

/** Parse the `/api/graph` query string into a GraphQuery (ints + bool flag). */
export function parseGraphQuery(searchParams: URLSearchParams): GraphQuery {
  const q: GraphQuery = {};
  const session = intParam(searchParams.get('session'));
  if (session !== undefined) q.session = session;
  const topN = intParam(searchParams.get('topN'));
  if (topN !== undefined) q.topN = topN;
  const limit = intParam(searchParams.get('limit'));
  if (limit !== undefined) q.limit = limit;
  const sim = searchParams.get('similarity');
  if (sim !== null) q.similarity = sim === '1' || sim.toLowerCase() === 'true';
  return q;
}

function intParam(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) ? n : undefined;
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function sendText(res: import('node:http').ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/** Resolve and serve a static asset under the static dir, with a traversal guard. */
async function serveStatic(
  res: import('node:http').ServerResponse,
  dir: string,
  relPath: string,
): Promise<void> {
  const ext = extname(relPath).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    sendText(res, 403, 'forbidden');
    return;
  }
  // Resolve the requested path against the static dir, then assert the resolved
  // realpath stays UNDER the static dir (defends against ../ traversal).
  const candidate = resolve(join(dir, relPath));
  const dirWithSep = dir.endsWith(sep) ? dir : dir + sep;
  if (candidate !== dir && !candidate.startsWith(dirWithSep)) {
    sendText(res, 403, 'forbidden');
    return;
  }
  if (!existsSync(candidate)) {
    sendText(res, 404, 'not found');
    return;
  }
  // realpath defends against symlink escape too.
  const real = realpathSync(candidate);
  if (real !== dir && !real.startsWith(dirWithSep)) {
    sendText(res, 403, 'forbidden');
    return;
  }
  try {
    const data = await readFile(real);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch {
    sendText(res, 404, 'not found');
  }
}

/**
 * Build the HTTP server (not yet listening). Exposed for tests that want full
 * control over the lifecycle; most callers want `startUiServer`.
 */
export function createUiServer(memory: Memory, opts: UiServerOptions = {}): Server {
  const dir = opts.staticDir ? resolve(opts.staticDir) : defaultStaticDir();

  return createServer((req, res) => {
    // Read-only: only GET is allowed. Everything else is 405.
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET' });
      res.end('method not allowed');
      return;
    }

    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      void serveStatic(res, dir, 'index.html');
      return;
    }

    if (path === '/api/graph') {
      try {
        const query = parseGraphQuery(url.searchParams);
        const data = buildGraph(memory.store, query);
        sendJson(res, 200, data);
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    if (path.startsWith('/static/') || path.startsWith('/assets/')) {
      // Strip the prefix; decode percent-encoding so `..%2f` is normalized and
      // then caught by the realpath guard rather than served raw.
      const prefix = path.startsWith('/static/') ? '/static/' : '/assets/';
      let rel: string;
      try {
        rel = decodeURIComponent(path.slice(prefix.length));
      } catch {
        sendText(res, 400, 'bad request');
        return;
      }
      void serveStatic(res, dir, rel);
      return;
    }

    sendText(res, 404, 'not found');
  });
}

/**
 * Start the server on 127.0.0.1, retrying the next port on EADDRINUSE (up to
 * MAX_PORT_ATTEMPTS). Resolves with the ACTUAL bound port + URL.
 */
export function startUiServer(
  memory: Memory,
  opts: UiServerOptions = {},
): Promise<{ server: Server; url: string; port: number }> {
  const startPort = opts.port ?? DEFAULT_UI_PORT;

  return new Promise((resolvePromise, reject) => {
    let attempt = 0;

    const tryListen = (port: number): void => {
      const server = createUiServer(memory, opts);

      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS - 1) {
          attempt += 1;
          tryListen(port + 1);
          return;
        }
        if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `could not bind a UI port: ${startPort}..${startPort + MAX_PORT_ATTEMPTS - 1} all in use`,
            ),
          );
          return;
        }
        reject(err);
      };

      const onListening = (): void => {
        server.removeListener('error', onError);
        const addr = server.address();
        const boundPort = addr && typeof addr === 'object' ? addr.port : port;
        resolvePromise({ server, url: `http://${HOST}:${boundPort}`, port: boundPort });
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, HOST);
    };

    tryListen(startPort);
  });
}
