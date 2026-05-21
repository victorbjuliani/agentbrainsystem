import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchHook } from './dispatch.js';

const savedExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = savedExitCode;
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
