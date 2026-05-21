/**
 * E2E harness — drives the BUILT `abs` binary (`dist/cli/cli.js`), the MCP server
 * over stdio, the localhost UI, and a fake OpenAI-compatible LLM, all against a
 * throwaway temp HOME/ABS_HOME so the real store (`~/.agentbrainsystem`) and real
 * Claude Code config (`~/.claude`) are NEVER touched.
 *
 * Isolation primitive (`makeHome`): every spawned process inherits
 *   ABS_HOME = <tmp>/abs   → the SQLite store
 *   HOME     = <tmp>       → settings.json (hooks) + projectsDir (optimize auto-memory)
 * Teardown is `rm -rf <tmp>` — that is the whole "leave no trace" contract.
 *
 * Offline note: the embedding model cache lives in
 * `node_modules/@huggingface/transformers/.cache` (NOT under HOME), so overriding
 * HOME is safe and does not re-download. Offline is a consequence of the cache
 * being warm (the global-setup pre-flight guarantees it), not of any env flag —
 * @huggingface/transformers@4.x ignores TRANSFORMERS_OFFLINE/HF_HUB_OFFLINE.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
/** The built CLI entrypoint under test (real artifact, not tsx). */
export const CLI = resolve(REPO_ROOT, 'dist/cli/cli.js');
/** The committed fixture transcripts directory (ingest reads project subdirs here). */
export const FIXTURES_PROJECTS = resolve(HERE, 'fixtures/projects');

export interface E2EHome {
  /** Temp HOME root (also the Claude Code home for hooks/optimize). */
  home: string;
  /** Isolated ABS_HOME (store lives at <absHome>/memory.db). */
  absHome: string;
  /** Env to pass to every spawned `abs` process. */
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/**
 * Create an isolated temp home. `extra` overrides env keys (set a key to undefined
 * to unset it). LLM is OFF by default — scenarios that need it pass ABS_LLM_* via
 * `extra` (pointed at `fakeOpenAi`).
 */
export function makeHome(extra: Record<string, string | undefined> = {}): E2EHome {
  const home = mkdtempSync(join(tmpdir(), 'abs-e2e-'));
  const absHome = join(home, 'abs');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ABS_HOME: absHome,
    ABS_EMBED_PROVIDER: 'local',
  };
  // Never leak a real LLM config from the parent environment into a scenario.
  for (const k of ['ABS_LLM_BASE_URL', 'ABS_LLM_MODEL', 'ABS_LLM_API_KEY', 'ABS_DB_PATH']) {
    delete env[k];
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return {
    home,
    absHome,
    env,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run `node dist/cli/cli.js <args>` to completion, optionally feeding `input` on
 * stdin. Resolves with stdout/stderr/exit-code (never rejects on a non-zero exit —
 * the caller asserts the code). Rejects only on spawn error or timeout.
 */
export function abs(
  args: string[],
  opts: { env: NodeJS.ProcessEnv; input?: string; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('node', [CLI, ...args], { env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`abs ${args.join(' ')} timed out\nstdout:${stdout}\nstderr:${stderr}`));
    }, opts.timeoutMs ?? 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, code: code ?? -1 });
    });
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** Parse the JSON `abs status` / `abs ingest` print into a typed object. */
export function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

// --- MCP stdio client -------------------------------------------------------

/** Connect a real MCP client to a freshly spawned `abs start` over stdio. */
export async function mcpClient(env: NodeJS.ProcessEnv): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI, 'start'],
    env: env as Record<string, string>,
  });
  const client = new Client({ name: 'abs-e2e', version: '0.0.0' });
  try {
    await client.connect(transport);
  } catch (e) {
    // A handshake failure (e.g. the server boots into a broken store) would
    // otherwise orphan the spawned `abs start` child — close the transport first.
    await transport.close().catch(() => {});
    throw e;
  }
  return client;
}

/** Call an MCP tool and JSON-parse its single text content block. */
export async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
  };
  return JSON.parse(res.content[0]?.text ?? 'null') as T;
}

// --- UI server --------------------------------------------------------------

export interface UiHandle {
  baseUrl: string;
  stop(): void;
}

/**
 * Spawn `abs ui` on a random high port (the server retries +1 on collision) and
 * resolve once it prints its bound URL to stdout. `stop()` SIGTERMs it (cmdUi's
 * handler closes the server + store and exits 0).
 */
export function startUi(env: NodeJS.ProcessEnv): Promise<UiHandle> {
  return new Promise((resolveUi, reject) => {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    const child = spawn('node', [CLI, 'ui', '--port', String(port)], { env });
    let buf = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`abs ui did not print a URL in time\nstdout:${buf}`));
    }, 30_000);
    const onData = (d: Buffer): void => {
      buf += String(d);
      // Require the trailing boundary (the CLI prints `url\n`) so a split stdout
      // chunk can't resolve us with a truncated port.
      const m = buf.match(/http:\/\/127\.0\.0\.1:\d+(?=\s)/);
      if (m) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolveUi({ baseUrl: m[0], stop: () => child.kill('SIGTERM') });
      }
    };
    child.stdout.on('data', onData);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// --- Fake OpenAI-compatible LLM --------------------------------------------

export interface FakeLlm {
  /** Use as ABS_LLM_BASE_URL — already includes the `/v1` suffix the client expects. */
  baseUrl: string;
  /** How many /chat/completions calls were received. */
  calls(): number;
  stop(): void;
}

/**
 * A localhost OpenAI-compatible endpoint that answers `POST /v1/chat/completions`
 * with `content` (the model "reply"). For `abs consolidate`, `content` must be a
 * JSON-stringified array of `{kind:'lesson'|'decision', content:string}` — the exact
 * shape `distill.ts` parses. Stays $0/offline (no real network).
 */
export function fakeOpenAi(content: string): Promise<FakeLlm> {
  return new Promise((resolveFake) => {
    let calls = 0;
    const server: Server = createServer((req, res) => {
      if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
        calls += 1;
        req.resume(); // drain the request body
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content } }],
              usage: { prompt_tokens: 120, completion_tokens: 48 },
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolveFake({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        calls: () => calls,
        stop: () => server.close(),
      });
    });
  });
}

/** Best-effort kill of a stray child (used in afterEach safety nets). */
export function kill(child: ChildProcess | undefined): void {
  try {
    child?.kill('SIGKILL');
  } catch {
    // ignore
  }
}
