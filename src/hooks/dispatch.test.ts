import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchHook } from './dispatch.js';
import type { HookPayload } from './payload.js';

const savedExitCode = process.exitCode;

// Isolate the store these hooks read. Without this the session-start handler
// loads the developer's REAL ~/.agentbrainsystem store, so its baseline output
// depends on whatever happens to be ingested there — the no-op assertion below
// only held while that store was empty. Point ABS_DB_PATH at a fresh temp db so
// every run starts from a known-empty store.
let tmpDir: string;
let savedDbPath: string | undefined;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'abs-dispatch-'));
  savedDbPath = process.env.ABS_DB_PATH;
  process.env.ABS_DB_PATH = join(tmpDir, 'memory.db');
});

afterEach(() => {
  process.exitCode = savedExitCode;
  if (savedDbPath === undefined) delete process.env.ABS_DB_PATH;
  else process.env.ABS_DB_PATH = savedDbPath;
  rmSync(tmpDir, { recursive: true, force: true });
});

function stdinOf(obj: unknown): Readable {
  return Readable.from([Buffer.from(JSON.stringify(obj))]);
}

describe('dispatchHook — routing + non-fatal', () => {
  it('is a non-fatal no-op for an unknown event', async () => {
    const out: string[] = [];
    await dispatchHook('not-a-real-event', { stdin: stdinOf({}), stdout: (l) => out.push(l) });
    expect(out).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('runs a known no-op handler (session-start placeholder) without emitting', async () => {
    const out: string[] = [];
    await dispatchHook('session-start', {
      stdin: stdinOf({ source: 'startup' }),
      stdout: (l) => out.push(l),
    });
    expect(out).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('never throws even when stdin is malformed', async () => {
    const out: string[] = [];
    const errs: string[] = [];
    await dispatchHook('user-prompt-submit', {
      stdin: Readable.from([Buffer.from('garbage{{{')]),
      stdout: (l) => out.push(l),
      stderr: (l) => errs.push(l),
    });
    expect(process.exitCode).toBe(0);
  });
});

describe('dispatchHook — chokepoint namespacing (C-NEW-1/R4, #67)', () => {
  // Inject a capturing handler so we observe the EXACT payload the chokepoint
  // hands downstream — directly proving the session id was namespaced BEFORE any
  // handler runs, with no dependency on whether session-start happens to render a
  // notice line. Assertions always run (no vacuous `if` guards).
  function capturing() {
    const captured: HookPayload[] = [];
    const handlers: Record<string, (p: HookPayload) => Promise<string | undefined>> = {
      'session-start': async (p) => {
        captured.push(p);
        return undefined;
      },
    };
    return { captured, handlers };
  }

  it('namespaces payload.sessionId ONCE at dispatch for a Codex transcript', async () => {
    const { captured, handlers } = capturing();
    await dispatchHook('session-start', {
      stdin: stdinOf({
        session_id: '019e2658-c8b0-7230-9b59-c3646fbf0c7b',
        cwd: '/work/proj',
        transcript_path:
          '/u/.codex/sessions/2026/05/14/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl',
        source: 'startup',
      }),
      handlers,
    });
    expect(captured).toHaveLength(1);
    // The handler RECEIVED the namespaced id — applied exactly once, never bare.
    expect(captured[0]?.sessionId).toBe('codex:019e2658-c8b0-7230-9b59-c3646fbf0c7b');
    expect(captured[0]?.sessionId).not.toContain('codex:codex:'); // single-application guard
  });

  it('leaves a Claude payload sessionId BARE at dispatch (regression)', async () => {
    const { captured, handlers } = capturing();
    await dispatchHook('session-start', {
      stdin: stdinOf({
        session_id: 'abc-123',
        cwd: '/work/proj',
        transcript_path: '/u/.claude/projects/-x/sess.jsonl',
        source: 'startup',
      }),
      handlers,
    });
    expect(captured).toHaveLength(1);
    // Bare id reaches the handler unchanged — never prefixed for Claude.
    expect(captured[0]?.sessionId).toBe('abc-123');
    expect(captured[0]?.sessionId).not.toContain('claude-code:');
    expect(captured[0]?.sessionId).not.toContain('codex:');
  });
});
