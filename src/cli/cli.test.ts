/**
 * CLI `forget` parsing + selector tests (Phase B1).
 *
 * `cli.ts` is a thin argv→core layer; the parsing logic that needs coverage is the
 * `--ids` validation (dedupe, reject empty/non-numeric/≤0) and the selector
 * mutual-exclusion gate, both factored into testable pure helpers. The actual
 * preview/delete mechanics are the Phase A core's responsibility (covered in
 * `src/delete/delete.test.ts`); here we prove the CLI resolves argv into the right
 * selector and refuses ambiguous/empty input.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { __clearDeleteCacheForTests } from '../delete/delete.js';
import { type Memory, openMemory } from '../memory.js';
import {
  cmdForget,
  cmdProject,
  parseForgetSelector,
  parseIds,
  parseProjectAction,
  resolveSessionId,
} from './cli.js';

describe('parseIds — --ids validation', () => {
  it('parses a comma list into positive ids', () => {
    expect(parseIds('1,2,3')).toEqual([1, 2, 3]);
  });

  it('dedupes repeated ids, preserving first-seen order', () => {
    expect(parseIds('3,1,3,1,2')).toEqual([3, 1, 2]);
  });

  it('trims whitespace around tokens', () => {
    expect(parseIds(' 1 , 2 , 3 ')).toEqual([1, 2, 3]);
  });

  it('rejects an empty token', () => {
    expect(() => parseIds('1,,3')).toThrow(/empty entry/);
  });

  it('rejects a non-numeric token (no silent parseInt truncation)', () => {
    expect(() => parseIds('1,12a,3')).toThrow(/positive integers/);
    expect(() => parseIds('abc')).toThrow(/positive integers/);
  });

  it('rejects a non-positive id', () => {
    expect(() => parseIds('1,0,3')).toThrow(/positive integers/);
    expect(() => parseIds('-5')).toThrow(/positive integers/);
  });

  it('rejects an all-empty input', () => {
    expect(() => parseIds('')).toThrow(/empty entry/);
  });
});

describe('parseForgetSelector — mutual exclusion + shapes', () => {
  it('resolves --ids to a byIds selector', () => {
    expect(parseForgetSelector(['--ids', '1,2'])).toEqual({ byIds: [1, 2] });
  });

  it('resolves --session to a bySession selector', () => {
    expect(parseForgetSelector(['--session', '7'])).toEqual({ bySession: 7 });
  });

  it('rejects a non-positive --session', () => {
    expect(() => parseForgetSelector(['--session', '0'])).toThrow(/positive integer/);
    expect(() => parseForgetSelector(['--session', '1.5'])).toThrow(/positive integer/);
  });

  it('resolves --project NAME to a byProject literal selector', () => {
    expect(parseForgetSelector(['--project', 'webapp'])).toEqual({ byProject: 'webapp' });
  });

  it('treats --project null as the LITERAL string "null"', () => {
    expect(parseForgetSelector(['--project', 'null'])).toEqual({ byProject: 'null' });
  });

  it('treats --null-project as the NULL-project selector (distinct from --project null)', () => {
    expect(parseForgetSelector(['--null-project'])).toEqual({ byProject: null });
  });

  it('resolves --search with no limit', () => {
    expect(parseForgetSelector(['--search', 'deploy'])).toEqual({
      bySearch: { query: 'deploy' },
    });
  });

  it('resolves --search with --limit', () => {
    expect(parseForgetSelector(['--search', 'deploy', '--limit', '5'])).toEqual({
      bySearch: { query: 'deploy', limit: 5 },
    });
  });

  it('rejects an empty --search query', () => {
    expect(() => parseForgetSelector(['--search', '   '])).toThrow(/non-empty query/);
  });

  it('rejects a non-positive --limit', () => {
    expect(() => parseForgetSelector(['--search', 'q', '--limit', '0'])).toThrow(
      /positive integer/,
    );
  });

  it('errors when no selector is given', () => {
    expect(() => parseForgetSelector([])).toThrow(/exactly one selector/);
  });

  it('errors when more than one selector is given', () => {
    expect(() => parseForgetSelector(['--ids', '1', '--session', '2'])).toThrow(
      /mutually exclusive/,
    );
    expect(() => parseForgetSelector(['--null-project', '--project', 'x'])).toThrow(
      /mutually exclusive/,
    );
  });
});

describe('cmdForget — preview default + apply path (hermetic, tmp ABS_HOME)', () => {
  let dir: string;
  let outLines: string[];

  /** Seed a store under a tmp ABS_HOME with FTS-indexed observations; return ids. */
  async function seed(): Promise<{ a: number; b: number }> {
    // ensure:false + write through the indexer would embed; instead create + index
    // FTS directly so the suite never loads the embedding model.
    const mem: Memory = await openMemory(loadConfig(), { ensure: false });
    const s = mem.store.createSession({ externalId: 's1' });
    const a = mem.store.createObservation({ sessionId: s, kind: 'user', content: 'alpha needle' });
    mem.store.indexFts(a, 'alpha needle');
    const b = mem.store.createObservation({ sessionId: s, kind: 'user', content: 'beta haystack' });
    mem.store.indexFts(b, 'beta haystack');
    mem.close();
    return { a, b };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-cli-forget-'));
    process.env.ABS_HOME = dir;
    // Keep the embed dimension tiny — never used (no embed on this path) but cheap.
    process.env.ABS_EMBED_DIM = '8';
    __clearDeleteCacheForTests();
    outLines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      outLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ABS_HOME;
    delete process.env.ABS_EMBED_DIM;
    rmSync(dir, { recursive: true, force: true });
  });

  it('preview is the default and writes nothing', async () => {
    const { a, b } = await seed();
    await cmdForget(['--ids', `${a},${b}`]);

    const text = outLines.join('');
    expect(text).toContain('forget preview');
    expect(text).toContain('IRREVERSIBLE — export first');
    expect(text).toContain('(preview — nothing deleted');

    // Re-open and confirm both observations still exist.
    const mem = await openMemory(loadConfig(), { ensure: false });
    expect(mem.store.getObservation(a)).not.toBeNull();
    expect(mem.store.getObservation(b)).not.toBeNull();
    mem.close();
  });

  it('--search resolves via FTS only (ensure:false → no embedding model load) and previews', async () => {
    await seed();
    // If this path embedded, the local model would have to load — it does not, because
    // bySearch is FTS-only and ensure:false skips the startup index check.
    await cmdForget(['--search', 'needle']);
    const text = outLines.join('');
    expect(text).toContain('forget preview — 1 observation(s)');
    expect(text).toContain('needle');
  });

  it('--apply --yes deletes the resolved set and prints a machine-readable summary', async () => {
    const { a, b } = await seed();
    await cmdForget(['--ids', `${a},${b}`, '--apply', '--yes']);

    const text = outLines.join('');
    expect(text).toContain(`"deleted":[${a},${b}]`);

    const mem = await openMemory(loadConfig(), { ensure: false });
    expect(mem.store.getObservation(a)).toBeNull();
    expect(mem.store.getObservation(b)).toBeNull();
    mem.close();
  });

  it('a zero-match selector prints "nothing to delete" and writes nothing', async () => {
    await seed();
    await cmdForget(['--session', '99999', '--apply', '--yes']);
    const text = outLines.join('');
    expect(text).toContain('nothing to delete');
  });
});

describe('parseProjectAction — exactly one action', () => {
  it('defaults to status with no flags', () => {
    expect(parseProjectAction([])).toEqual({ kind: 'status' });
    expect(parseProjectAction(['--json'])).toEqual({ kind: 'status' });
  });

  it('parses --cwd and --skip', () => {
    expect(parseProjectAction(['--cwd'])).toEqual({ kind: 'cwd' });
    expect(parseProjectAction(['--skip'])).toEqual({ kind: 'skip' });
  });

  it('rejects more than one action', () => {
    expect(parseProjectAction(['--cwd', '--skip'])).toEqual({
      error: expect.stringContaining('exactly one'),
    });
  });
});

describe('resolveSessionId — env vs --session, no mtime fallback', () => {
  // The suite runs inside a real Claude Code session, so the ambient env var
  // would leak in — clear it and set it explicitly per test.
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });
  afterEach(() => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  it('prefers an explicit --session', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-id';
    expect(resolveSessionId(['--session', 'flag-id'])).toEqual({ id: 'flag-id', source: 'flag' });
  });

  it('falls back to CLAUDE_CODE_SESSION_ID', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-id';
    expect(resolveSessionId([])).toEqual({ id: 'env-id', source: 'env' });
  });

  it('returns null when neither is present (no transcript guessing)', () => {
    expect(resolveSessionId([])).toBeNull();
  });

  it('ERRORS on a --session with a flag-shaped value — never falls back to env (Codex P1)', () => {
    // A typo like `abs project --skip --session --yes` must not silently retarget
    // the ambient session for a destructive --skip.
    process.env.CLAUDE_CODE_SESSION_ID = 'env-id';
    expect(resolveSessionId(['--session', '--json'])).toEqual({
      error: expect.stringContaining('--session requires'),
    });
    expect(resolveSessionId(['--skip', '--session', '--yes'])).toEqual({
      error: expect.stringContaining('--session requires'),
    });
  });
});

describe('cmdProject — set / cwd / skip / status (hermetic, tmp ABS_HOME)', () => {
  let dir: string;
  let outLines: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-cli-project-'));
    process.env.ABS_HOME = dir;
    process.env.ABS_EMBED_DIM = '8';
    outLines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      outLines.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      outLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ABS_HOME;
    delete process.env.ABS_EMBED_DIM;
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it('--cwd binds the cwd-derived slug', async () => {
    await cmdProject(['--session', 'sess-B', '--cwd', '--json']);
    const o = JSON.parse(outLines.join(''));
    expect(o.action).toBe('set');
    expect(o.project).toBe(process.cwd().split('/').join('-'));
  });

  it('--skip with no stored observations writes the binding directly', async () => {
    await cmdProject(['--session', 'sess-C', '--skip', '--json']);
    const o = JSON.parse(outLines.join(''));
    expect(o).toMatchObject({ action: 'skip', applied: true, deleted: 0 });

    const mem = await openMemory(loadConfig(), { ensure: false });
    expect(mem.store.getMeta('session-project:sess-C')).toContain('"action":"skip"');
    mem.close();
  });

  it('--skip with stored observations requires --yes (preview-only without it)', async () => {
    // seed a session with an observation, then mark it skip without --yes
    const mem = await openMemory(loadConfig(), { ensure: false });
    const sid = mem.store.createSession({ externalId: 'sess-D', project: 'auto' });
    mem.store.createObservation({ sessionId: sid, kind: 'user', content: 'hi' });
    mem.close();

    await cmdProject(['--session', 'sess-D', '--skip', '--json']);
    const o = JSON.parse(outLines.join(''));
    expect(o).toMatchObject({ action: 'skip', wouldDelete: 1, applied: false });

    // nothing written / deleted
    const mem2 = await openMemory(loadConfig(), { ensure: false });
    expect(mem2.store.getSessionByExternalId('sess-D')).not.toBeNull();
    expect(mem2.store.getMeta('session-project:sess-D')).toBeNull();
    mem2.close();
  });

  it('--skip --yes hard-deletes the stored session and writes the binding', async () => {
    const mem = await openMemory(loadConfig(), { ensure: false });
    const sid = mem.store.createSession({ externalId: 'sess-E', project: 'auto' });
    mem.store.createObservation({ sessionId: sid, kind: 'user', content: 'hi' });
    mem.close();

    await cmdProject(['--session', 'sess-E', '--skip', '--yes', '--json']);
    const o = JSON.parse(outLines.join(''));
    expect(o).toMatchObject({ action: 'skip', applied: true, deleted: 1 });

    const mem2 = await openMemory(loadConfig(), { ensure: false });
    expect(mem2.store.getSessionByExternalId('sess-E')).toBeNull();
    expect(mem2.store.getMeta('session-project:sess-E')).toContain('"action":"skip"');
    mem2.close();
  });

  it('status (no action) lists existing projects as JSON', async () => {
    const mem = await openMemory(loadConfig(), { ensure: false });
    mem.store.createSession({ externalId: 's-x', project: 'Alpha' });
    mem.store.createSession({ externalId: 's-y', project: 'Beta' });
    mem.close();

    await cmdProject(['--session', 'sess-F', '--json']);
    const o = JSON.parse(outLines.join(''));
    expect(o.session).toBe('sess-F');
    expect(o.existingProjects).toEqual(['Alpha', 'Beta']);
    expect(o.autoProject).toBe(process.cwd().split('/').join('-'));
    expect(o.binding).toBeNull();
  });

  it('errors with no resolvable session id', async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    await cmdProject(['--skip', '--json']);
    expect(outLines.join('')).toContain('no current session id');
    expect(process.exitCode).toBe(1);
  });

  it('errors on a flag-shaped --session value instead of retargeting (Codex P1)', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'ambient';
    await cmdProject(['--skip', '--session', '--yes']);
    expect(outLines.join('')).toContain('--session requires');
    expect(process.exitCode).toBe(1);
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  it('--cwd applies immediately to an already-ingested session row (Codex P2)', async () => {
    // Simulate a fully-ingested session whose file will never grow again.
    const mem = await openMemory(loadConfig(), { ensure: false });
    mem.store.createSession({ externalId: 'sess-ingested', project: 'old-slug' });
    mem.close();

    await cmdProject(['--session', 'sess-ingested', '--cwd', '--json']);
    const o = JSON.parse(outLines.join(''));
    const cwdSlug = process.cwd().split('/').join('-');
    expect(o).toMatchObject({ action: 'set', project: cwdSlug });

    const mem2 = await openMemory(loadConfig(), { ensure: false });
    // The stored row is updated NOW, not left under the old project awaiting a re-ingest.
    expect(mem2.store.getSessionByExternalId('sess-ingested')?.project).toBe(cwdSlug);
    mem2.close();
  });
});
