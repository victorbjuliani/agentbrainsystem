import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchHook } from './dispatch.js';

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
  it('namespaces payload.sessionId ONCE at dispatch for a Codex transcript', async () => {
    const out: string[] = [];
    await dispatchHook('session-start', {
      stdin: stdinOf({
        session_id: '019e2658-c8b0-7230-9b59-c3646fbf0c7b',
        cwd: '/work/proj',
        transcript_path:
          '/u/.codex/sessions/2026/05/14/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl',
        source: 'startup',
      }),
      stdout: (l) => out.push(l),
    });
    const joined = out.join('\n');
    if (joined.includes('session=')) {
      expect(joined).toContain('codex:019e2658-c8b0-7230-9b59-c3646fbf0c7b');
      expect(joined).not.toMatch(/session="019e2658-c8b0-7230-9b59-c3646fbf0c7b"/); // never bare for Codex
      expect(joined).not.toContain('codex:codex:'); // single-application guard
    }
  });

  it('leaves a Claude payload sessionId BARE at dispatch (regression)', async () => {
    const out: string[] = [];
    await dispatchHook('session-start', {
      stdin: stdinOf({
        session_id: 'abc-123',
        cwd: '/work/proj',
        transcript_path: '/u/.claude/projects/-x/sess.jsonl',
        source: 'startup',
      }),
      stdout: (l) => out.push(l),
    });
    const joined = out.join('\n');
    if (joined.includes('session=')) {
      expect(joined).toContain('abc-123'); // bare id reaches the handler unchanged
      expect(joined).not.toContain('claude-code:abc-123'); // never prefixed for Claude
      expect(joined).not.toContain('codex:abc-123');
    }
  });
});
