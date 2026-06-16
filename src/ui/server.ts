/**
 * The localhost memory-graph HTTP server (issue #11; write-path added in #B2).
 *
 * Security posture (single-user, localhost, no login — defence-in-depth instead):
 *   - Binds 127.0.0.1 ONLY — never 0.0.0.0. The server is never exposed to the LAN.
 *   - The read graph is GET-only. The ONLY non-GET surface is the selective
 *     hard-delete write path (`POST /api/delete/preview`, `DELETE /api/delete`),
 *     which supersedes the original GET-only invariant (ADR-0007). Every OTHER
 *     non-GET request is still 405.
 *   - Static serving is allowlisted by extension and guarded against path
 *     traversal: the resolved realpath must stay UNDER the static dir, else 403.
 *   - The static dir is resolved via `import.meta.url` (NOT process.cwd()), so it
 *     works regardless of where the process was launched from. It lives at
 *     `../ui/static` relative to the compiled `dist/ui/server.js` → `dist/ui/static`.
 *
 * The delete write path carries FOUR controls (ADR-0007); see `deleteGuards`:
 *   1. Method gate — only the two delete routes accept their specific non-GET method.
 *   2. Host/Origin allowlist (anti DNS-rebinding / cross-site) keyed on the REAL
 *      bound port (`req.socket.localPort`, which survives the EADDRINUSE retry).
 *   3. Per-process CSRF token required in `X-ABS-CSRF` on BOTH delete routes.
 *   4. Server-side handle confirmation — `DELETE` only ever deletes the id set a
 *      prior `preview` pinned (enforced inside the delete core).
 *
 * The selector arrives in the QUERY STRING (never a request body), so this module
 * imports no body parser and exposes no request-stream surface (ADR-0007).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeleteSelector } from '../delete/index.js';
import { DeleteRefusalError, execute, preview } from '../delete/index.js';
import type { Memory } from '../memory.js';
import { buildGraph } from './graph.js';
import type { GraphQuery } from './graph-types.js';

/**
 * Per-process CSRF token (Control 3). Minted once at module load with a CSPRNG so
 * it never crosses a process boundary; a process restart mints a new one, which is
 * why the client falls back to reloading `/` on a 403 (stale token). The token is
 * injected into `index.html` at request time (see `serveIndex`) and echoed back by
 * the client in `X-ABS-CSRF`.
 */
const CSRF_TOKEN = randomBytes(32).toString('hex');

/** Placeholder substituted with the live CSRF token when serving `/`. */
const CSRF_PLACEHOLDER = '__ABS_CSRF__';

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
  // `search` (#35): a non-empty value switches buildGraph to store-wide FTS mode.
  // An empty/whitespace value is dropped so it never shadows the topN/session scope.
  const search = searchParams.get('search');
  if (search !== null && search.trim() !== '') q.search = search;
  // `project` (#62-B): a non-empty value scopes the topN window to one project.
  // Empty/whitespace is dropped so it never narrows the scope to nothing by accident.
  const project = searchParams.get('project');
  if (project !== null && project.trim() !== '') q.project = project;
  return q;
}

function intParam(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) ? n : undefined;
}

/** A positive integer (> 0) or `undefined`. Rejects 0, negatives, NaN, floats. */
function positiveIntParam(raw: string | null): number | undefined {
  const n = intParam(raw);
  return n !== undefined && n > 0 ? n : undefined;
}

/** A bad-selector error surfaced as a clean 400 (never a 500). */
class SelectorError extends Error {}

/**
 * Hard cap on the number of ids a single `byIds` selector may name (SEC-01). Each
 * id costs a `getObservation` at resolve time, so an unbounded array is a local DoS
 * vector. 10_000 is well above any realistic manual delete while bounding the work.
 */
const MAX_BY_IDS = 10_000;

/**
 * Map the `/api/delete*` query string to a core `DeleteSelector`. The selector
 * never comes from a request body — `URLSearchParams` already percent/unicode
 * decodes, so the parser only validates shape + numeric domains. Throws a
 * `SelectorError` (→ 400) on anything malformed so a bad input is never a 500.
 *
 *   ?sel=ids&ids=1,2,3   → { byIds: [1,2,3] }   (positive ints, deduped)
 *   ?sel=session&id=5    → { bySession: 5 }
 *   ?sel=project&project=NAME → { byProject: 'NAME' }
 *   ?sel=null-project    → { byProject: null }
 *   ?sel=search&q=…&limit=8   → { bySearch: { query, limit? } }
 */
export function parseDeleteSelector(params: URLSearchParams): DeleteSelector {
  const sel = params.get('sel');
  switch (sel) {
    case 'ids': {
      const raw = params.get('ids');
      if (raw === null || raw.trim() === '') throw new SelectorError('ids selector needs ?ids=');
      const parts = raw.split(',');
      if (parts.length > MAX_BY_IDS) {
        throw new SelectorError(`ids selector exceeds the ${MAX_BY_IDS}-id cap`);
      }
      const seen = new Set<number>();
      for (const part of parts) {
        const n = positiveIntParam(part.trim());
        if (n === undefined) throw new SelectorError(`invalid id in ?ids=: ${part}`);
        seen.add(n);
      }
      if (seen.size === 0) throw new SelectorError('ids selector resolved to no valid ids');
      return { byIds: [...seen] };
    }
    case 'session': {
      const id = positiveIntParam(params.get('id'));
      if (id === undefined) throw new SelectorError('session selector needs a positive ?id=');
      return { bySession: id };
    }
    case 'project': {
      const project = params.get('project');
      if (project === null || project === '') {
        throw new SelectorError('project selector needs ?project= (use sel=null-project for NULL)');
      }
      return { byProject: project };
    }
    case 'null-project':
      return { byProject: null };
    case 'search': {
      const query = params.get('q');
      if (query === null || query.trim() === '')
        throw new SelectorError('search selector needs ?q=');
      const limit = positiveIntParam(params.get('limit'));
      return { bySearch: limit !== undefined ? { query, limit } : { query } };
    }
    default:
      throw new SelectorError(`unknown ?sel=${sel ?? '(missing)'}`);
  }
}

/**
 * Controls 2 + 3 (run on BOTH delete routes). Returns `null` when the request
 * passes; otherwise an explanatory string for the 403. The real bound port comes
 * from `req.socket.localPort` — the only reliable port source inside the handler
 * closure, and it survives the EADDRINUSE retry that rebinds on a new port.
 */
function deleteGuards(req: IncomingMessage): string | null {
  const localPort = req.socket.localPort;
  if (localPort === undefined) return 'no bound port';

  // Control 2 — Host allowlist (anti DNS-rebinding): the Host header must name
  // 127.0.0.1/localhost on the REAL bound port. A foreign hostname (a rebind) or a
  // wrong port (a stale/forged value) is rejected.
  const allowedHosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`]);
  const host = req.headers.host;
  if (host === undefined || !allowedHosts.has(host)) return 'host not allowed';

  // Control 2 — Origin allowlist (anti cross-site): Origin is absent on same-origin
  // fetches; when present it must be one of our localhost origins.
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== null) {
    const allowedOrigins = new Set([
      `http://127.0.0.1:${localPort}`,
      `http://localhost:${localPort}`,
    ]);
    if (!allowedOrigins.has(origin)) return 'origin not allowed';
  }

  // Control 3 — per-process CSRF token. Absent or mismatched → reject. Even preview
  // is protected because it returns memory snippets.
  const token = req.headers['x-abs-csrf'];
  if (typeof token !== 'string' || token !== CSRF_TOKEN) return 'csrf token invalid';

  return null;
}

/**
 * Defence-in-depth headers for served HTML/static (SEC-02). `default-src 'self'`
 * is safe for this app: the client loads only same-origin assets (`/static/app.js`,
 * `/static/app.css`, `/static/fonts/*`) and fetches only same-origin `/api/*` — it
 * uses no inline `<script>`/`style=` and no dynamic code evaluation (runtime
 * `element.style` mutation is NOT governed by CSP), so nothing here is broken by the
 * policy. `nosniff` stops MIME-confusion; `DENY` blocks click-jacking via framing.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * Log a server-side fault to stderr and return a GENERIC 500 body (SEC-03). The
 * core's `e.message` is never echoed to the client — it may carry internal detail
 * (paths, SQL, schema) that aids an attacker. The deliberate, machine-readable 4xx
 * responses (400 bad selector, 403 csrf/host, 409 unknown-handle) are unaffected;
 * only the unexpected-fault 500 path is generalized.
 */
function sendInternalError(
  res: import('node:http').ServerResponse,
  context: string,
  e: unknown,
): void {
  // Server-side fault log (stderr) — never sent to the client.
  process.stderr.write(
    `[ui-server] ${context}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  sendJson(res, 500, { error: 'internal error' });
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
  // realpath defends against symlink escape too. F8-04: it can throw on a broken
  // symlink / loop / a path raced away after existsSync — contain it per-request as a
  // 404 rather than letting it bubble to an unhandledRejection that kills the server.
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    sendText(res, 404, 'not found');
    return;
  }
  if (real !== dir && !real.startsWith(dirWithSep)) {
    sendText(res, 403, 'forbidden');
    return;
  }
  try {
    const data = await readFile(real);
    res.writeHead(200, { 'Content-Type': contentType, ...SECURITY_HEADERS });
    res.end(data);
  } catch {
    sendText(res, 404, 'not found');
  }
}

/**
 * Serve `/` (and `/index.html`) with the CSRF token injected at REQUEST TIME.
 *
 * `/` no longer flows through `serveStatic` because the html must be templated:
 * the `__ABS_CSRF__` placeholder (in the static index.html, copied verbatim by the
 * build) is replaced with the live per-process token so the client can read it from
 * `<meta name="abs-csrf">`. The file is still resolved from the `import.meta.url`
 * static dir (NOT cwd) and sent with an explicit text/html content-type.
 */
async function serveIndex(res: import('node:http').ServerResponse, dir: string): Promise<void> {
  const file = resolve(join(dir, 'index.html'));
  // Same realpath containment guard serveStatic uses — defends against a symlinked
  // static dir even though the filename here is fixed.
  const dirWithSep = dir.endsWith(sep) ? dir : dir + sep;
  if (!existsSync(file)) {
    sendText(res, 404, 'not found');
    return;
  }
  // F8-04: same per-request containment as serveStatic — a realpath failure must not
  // escape as an unhandledRejection.
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    sendText(res, 404, 'not found');
    return;
  }
  if (real !== file && !real.startsWith(dirWithSep)) {
    sendText(res, 403, 'forbidden');
    return;
  }
  try {
    const html = await readFile(real, 'utf8');
    const templated = html.split(CSRF_PLACEHOLDER).join(CSRF_TOKEN);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
    res.end(templated);
  } catch {
    sendText(res, 404, 'not found');
  }
}

/** Run the core `preview` for a parsed selector → the read-only preview payload. */
function handleDeletePreview(
  res: import('node:http').ServerResponse,
  memory: Memory,
  url: URL,
): void {
  let selector: DeleteSelector;
  try {
    selector = parseDeleteSelector(url.searchParams);
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : 'bad selector' });
    return;
  }
  try {
    const result = preview(memory, selector);
    sendJson(res, 200, {
      handle: result.handle,
      count: result.count,
      items: result.items,
      notFound: result.notFound,
    });
  } catch (e) {
    sendInternalError(res, 'delete preview failed', e);
  }
}

/**
 * Execute a previously-previewed delete by handle (Control 4 — the core only ever
 * deletes the pinned set; an unknown/expired/replayed handle is surfaced as a clean
 * 409 JSON error, never a 500).
 */
function handleDeleteExecute(
  res: import('node:http').ServerResponse,
  memory: Memory,
  url: URL,
): void {
  const handle = url.searchParams.get('handle');
  if (handle === null || handle === '') {
    sendJson(res, 400, { error: 'delete needs ?handle=' });
    return;
  }
  try {
    const result = execute(memory, handle);
    sendJson(res, 200, { deleted: result.deleted, notFound: result.notFound });
  } catch (e) {
    if (e instanceof DeleteRefusalError) {
      sendJson(res, 409, { error: e.message, reason: e.reason });
      return;
    }
    sendInternalError(res, 'delete execute failed', e);
  }
}

/**
 * Build the HTTP server (not yet listening). Exposed for tests that want full
 * control over the lifecycle; most callers want `startUiServer`.
 */
export function createUiServer(memory: Memory, opts: UiServerOptions = {}): Server {
  const dir = opts.staticDir ? resolve(opts.staticDir) : defaultStaticDir();

  return createServer((req, res) => {
    // Parse the URL FIRST (Control 1): the route decides which method is allowed,
    // not a blanket non-GET → 405 guard. The two delete routes accept their own
    // non-GET method; every other route stays GET-only.
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // --- Write path: selective hard-delete (ADR-0007) ------------------------
    if (path === '/api/delete/preview') {
      if (method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
        res.end('method not allowed');
        return;
      }
      const denied = deleteGuards(req);
      if (denied !== null) {
        sendJson(res, 403, { error: denied });
        return;
      }
      handleDeletePreview(res, memory, url);
      return;
    }

    if (path === '/api/delete') {
      if (method !== 'DELETE') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'DELETE' });
        res.end('method not allowed');
        return;
      }
      const denied = deleteGuards(req);
      if (denied !== null) {
        sendJson(res, 403, { error: denied });
        return;
      }
      handleDeleteExecute(res, memory, url);
      return;
    }

    // --- Read path: GET-only (Control 1 — everything below stays GET-only) ----
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET' });
      res.end('method not allowed');
      return;
    }

    if (path === '/' || path === '/index.html') {
      // Templated at request time to inject the CSRF token (no longer serveStatic).
      void serveIndex(res, dir);
      return;
    }

    if (path === '/api/graph') {
      try {
        const query = parseGraphQuery(url.searchParams);
        const data = buildGraph(memory.store, query);
        sendJson(res, 200, data);
      } catch (e) {
        sendInternalError(res, 'graph build failed', e);
      }
      return;
    }

    // Read-only counts for the ambient companion's ingest pulse (DESIGN.md §12-A).
    // Counts ONLY — never observation content (SEC). The pulse reflects ingest
    // (maxObservationId growing), not recall, which never writes (see ADR-0015).
    if (path === '/api/stats') {
      try {
        const c = memory.store.counts();
        const stats: {
          sessions: number;
          observations: number;
          maxObservationId: number;
          newSince?: number;
        } = {
          sessions: c.sessions,
          observations: c.observations,
          maxObservationId: memory.store.maxObservationId(),
        };
        const sinceRaw = url.searchParams.get('since');
        if (sinceRaw !== null) {
          const since = Number.parseInt(sinceRaw, 10);
          if (Number.isInteger(since) && since >= 0) {
            stats.newSince = memory.store.countObservationsSince(since);
          }
        }
        sendJson(res, 200, stats);
      } catch (e) {
        sendInternalError(res, 'stats build failed', e);
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

/** The per-process CSRF token — exported for tests that need to forge a valid header. */
export function __csrfTokenForTests(): string {
  return CSRF_TOKEN;
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
