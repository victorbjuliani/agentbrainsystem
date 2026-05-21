import { afterEach, describe, expect, it } from 'vitest';
import { runHookSafely } from './runner.js';

const savedExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = savedExitCode;
});

describe('runHookSafely — non-fatal/timeout contract (ADR-0004)', () => {
  it('emits the handler stdout line on success and exits 0', async () => {
    const out: string[] = [];
    const errs: string[] = [];
    await runHookSafely(async () => 'context-line', {
      stdout: (l) => out.push(l),
      stderr: (l) => errs.push(l),
    });
    expect(out).toEqual(['context-line']);
    expect(errs).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('emits nothing on stdout when the handler returns undefined', async () => {
    const out: string[] = [];
    await runHookSafely(async () => undefined, { stdout: (l) => out.push(l) });
    expect(out).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('swallows a thrown error → stderr diagnostic, no stdout, exit 0', async () => {
    const out: string[] = [];
    const errs: string[] = [];
    await runHookSafely(
      async () => {
        throw new Error('boom');
      },
      { stdout: (l) => out.push(l), stderr: (l) => errs.push(l) },
    );
    expect(out).toEqual([]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('boom');
    expect(process.exitCode).toBe(0);
  });

  it('swallows a timeout → stderr diagnostic, no stdout, exit 0', async () => {
    const out: string[] = [];
    const errs: string[] = [];
    await runHookSafely(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('too-late'), 1000)),
      { timeoutMs: 20, stdout: (l) => out.push(l), stderr: (l) => errs.push(l) },
    );
    expect(out).toEqual([]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('timed out');
    expect(process.exitCode).toBe(0);
  });

  it('does not leak a non-zero exit code even when the handler set one', async () => {
    await runHookSafely(async () => {
      process.exitCode = 7;
      throw new Error('still must be 0');
    });
    expect(process.exitCode).toBe(0);
  });
});
