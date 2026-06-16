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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { __clearDeleteCacheForTests } from '../delete/delete.js';
import { getOrCreateGlobalSession } from '../global.js';
import type { GroundTruthProvider, ResolvedSymbol } from '../ground-truth/index.js';
import { buildOpencodeDb } from '../harness/capabilities/__fixtures__/opencode-db.js';
import type { HarnessAdapter } from '../harness/index.js';
import { optimizeCursorKey } from '../hooks/staleness.js';
import { type Memory, openMemory } from '../memory.js';
import { projectSlug } from '../optimize/targets.js';
import { EMBED_DEGRADED_KEY } from '../store/index.js';
import {
  cmdDoctor,
  cmdForget,
  cmdIngest,
  cmdOpencodeCapture,
  cmdOpencodeRecall,
  cmdOptimize,
  cmdProject,
  cmdPromote,
  cmdRemember,
  cmdUninstall,
  gatherHarnessStatus,
  parseForgetSelector,
  parseIds,
  parseProjectAction,
  resolveHarnesses,
  resolveSessionId,
} from './cli.js';

/**
 * Interactive-apply readline seam for the cmdOptimize tests. `cmdOptimize` builds a
 * `createInterface(...).question(prompt)` per candidate unless `--yes`; this mock makes
 * the answer deterministic via `readlineState.answer(prompt)`, which can inspect the
 * prompt text (it carries the target path, so a test can answer 'y' for the auto-memory
 * lesson and 'n' for the CLAUDE.md decision). Default declines everything (no writes).
 */
const readlineState = vi.hoisted(() => ({ answer: (_prompt: string): string => 'n' }));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: async (prompt: string) => readlineState.answer(prompt),
    close: () => {},
  }),
}));

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

  it('resolves --global to the reserved global project selector', () => {
    expect(parseForgetSelector(['--global'])).toEqual({ byProject: '__global__' });
  });

  it('rejects --global combined with another selector', () => {
    expect(() => parseForgetSelector(['--global', '--null-project'])).toThrow(/mutually exclusive/);
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

describe('cmdIngest — opt-in historical ingest (#62, hermetic, no model load)', () => {
  let dir: string;
  let projectsDir: string;
  let outLines: string[];
  let errLines: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-cli-ingest-'));
    process.env.ABS_HOME = dir;
    process.env.ABS_EMBED_DIM = '8';
    projectsDir = join(dir, 'projects');
    const projA = join(projectsDir, '-Users-me-A');
    mkdirSync(projA, { recursive: true });
    writeFileSync(
      join(projA, 'sa.jsonl'),
      `${JSON.stringify({ type: 'user', sessionId: 'sa', cwd: '/Users/me/A', uuid: 'ua', timestamp: '2026-05-20T10:00:00.000Z', message: { role: 'user', content: 'hi' } })}\n`,
    );
    outLines = [];
    errLines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      outLines.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      errLines.push(String(c));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ABS_HOME;
    delete process.env.ABS_EMBED_DIM;
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('previews by default — lists projects, writes nothing', async () => {
    await cmdIngest(['--dir', projectsDir]);
    const text = outLines.join('');
    expect(text).toContain('ingest preview');
    expect(text).toContain('-Users-me-A');
    expect(text).toContain('1 new / 1 total');
    expect(text).toContain('--apply');
    // Nothing was ingested.
    const mem = await openMemory(loadConfig(), { ensure: false });
    expect(mem.store.getSessionByExternalId('sa')).toBeNull();
    mem.close();
  });

  it('refuses --apply without a selector (no full ingest by accident)', async () => {
    await cmdIngest(['--apply', '--dir', projectsDir]);
    expect(errLines.join('')).toContain('refusing to ingest without a selector');
    expect(process.exitCode).toBe(1);
    // Returned before opening the store ⇒ nothing ingested.
    const mem = await openMemory(loadConfig(), { ensure: false });
    expect(mem.store.getSessionByExternalId('sa')).toBeNull();
    mem.close();
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

  it('promote moves an observation into the global brain', async () => {
    const mem = await openMemory(loadConfig(), { ensure: false });
    const sid = mem.store.createSession({ externalId: 's', project: '-Users-me-Devs-foo' });
    const id = mem.store.createObservation({
      sessionId: sid,
      kind: 'decision',
      content: 'monorepo via turborepo',
    });
    mem.store.indexFts(id, 'monorepo via turborepo');
    mem.close();

    await cmdPromote([String(id), '--json']);
    const o = JSON.parse(outLines.join(''));
    expect(o).toMatchObject({ id, scope: 'global', applied: true });

    const mem2 = await openMemory(loadConfig(), { ensure: false });
    const g = mem2.store.getSessionByExternalId('__global__');
    expect(mem2.store.getObservation(id)?.sessionId).toBe(g?.id);
    mem2.close();
  });

  it('promote rejects a non-integer / truncatable id (no silent parseInt truncation)', async () => {
    await cmdPromote(['42.9', '--json']);
    expect(outLines.join('')).toContain('positive observation id');
    expect(process.exitCode).toBe(1);
  });

  it('promote --as files a curated global copy, keeps the original, and indexes FTS', async () => {
    // The curated path embeds (indexer.write) — use the real local model width, not the
    // FTS-only dim-8 this block defaults to.
    process.env.ABS_EMBED_DIM = '384';
    const mem = await openMemory(loadConfig(), { ensure: false });
    const sid = mem.store.createSession({ externalId: 's-cur', project: '-Users-me-Devs-bar' });
    const id = mem.store.createObservation({
      sessionId: sid,
      kind: 'decision',
      content: 'use JWT; the signing secret is HUNTER2 in vault /proj/x',
    });
    mem.store.indexFts(id, 'use JWT; the signing secret is HUNTER2 in vault /proj/x');
    mem.close();

    await cmdPromote([String(id), '--as', 'prefer JWT for stateless auth', '--json']);
    const o = JSON.parse(outLines.join('')) as { id: number; newId: number; curated: boolean };
    expect(o).toMatchObject({ id, scope: 'global', curated: true, applied: true });
    expect(o.newId).toBeGreaterThan(0);

    const mem2 = await openMemory(loadConfig(), { ensure: false });
    const g = mem2.store.getSessionByExternalId('__global__');
    // original is untouched: still in its project session
    expect(mem2.store.getObservation(id)?.sessionId).toBe(sid);
    // curated copy lives in global with EXACTLY the curated text — no leaked secret
    const created = mem2.store.getObservation(o.newId);
    expect(created?.sessionId).toBe(g?.id);
    expect(created?.content).toBe('prefer JWT for stateless auth');
    expect(created?.content).not.toContain('HUNTER2');
    expect(created?.kind).toBe('decision');
    expect(created?.metadata).toMatchObject({ promotedFrom: id });
    // and it is FTS-recallable from the global brain
    const hits = mem2.recall.recallFts('stateless auth', {
      limit: 5,
      project: '-Users-me-Devs-bar',
      includeGlobal: true,
    });
    expect(hits.some((h) => h.observation.id === o.newId)).toBe(true);
    mem2.close();
  });

  it('promote --as normalizes a raw ingest kind (user/assistant/tool) to note', async () => {
    process.env.ABS_EMBED_DIM = '384';
    const mem = await openMemory(loadConfig(), { ensure: false });
    const sid = mem.store.createSession({ externalId: 's-kind', project: '-Users-me-Devs-k' });
    const id = mem.store.createObservation({ sessionId: sid, kind: 'tool_edit', content: 'raw' });
    mem.store.indexFts(id, 'raw');
    mem.close();

    await cmdPromote([String(id), '--as', 'reusable wording', '--json']);
    const o = JSON.parse(outLines.join('')) as { newId: number };

    const mem2 = await openMemory(loadConfig(), { ensure: false });
    expect(mem2.store.getObservation(o.newId)?.kind).toBe('note');
    mem2.close();
  });

  it('promote --as with empty text errors (exit 1) and mutates nothing', async () => {
    const mem = await openMemory(loadConfig(), { ensure: false });
    const sid = mem.store.createSession({ externalId: 's-empty', project: '-Users-me-Devs-e' });
    const id = mem.store.createObservation({ sessionId: sid, kind: 'note', content: 'x' });
    mem.close();

    await cmdPromote([String(id), '--as', '   ', '--json']);
    expect(process.exitCode).toBe(1);
    expect(outLines.join('')).toContain('non-empty');

    const mem2 = await openMemory(loadConfig(), { ensure: false });
    expect(mem2.store.getObservation(id)?.sessionId).toBe(sid); // untouched
    const g = mem2.store.getSessionByExternalId('__global__');
    if (g) expect(mem2.store.listObservations({ sessionId: g.id }).length).toBe(0);
    mem2.close();
  });

  it('promote rejects a flag-looking --as value (forgotten text) and mutates nothing', async () => {
    const mem = await openMemory(loadConfig(), { ensure: false });
    const sid = mem.store.createSession({ externalId: 's-flag', project: '-Users-me-Devs-f' });
    const id = mem.store.createObservation({ sessionId: sid, kind: 'note', content: 'x' });
    mem.close();

    await cmdPromote([String(id), '--as', '--json']);
    expect(process.exitCode).toBe(1);
    expect(outLines.join('')).toContain('looks like a flag');

    const mem2 = await openMemory(loadConfig(), { ensure: false });
    expect(mem2.store.getObservation(id)?.sessionId).toBe(sid); // untouched
    const g = mem2.store.getSessionByExternalId('__global__');
    if (g) expect(mem2.store.listObservations({ sessionId: g.id }).length).toBe(0);
    mem2.close();
  });

  it('promote with a bare --as (no value) errors and mutates nothing', async () => {
    const mem = await openMemory(loadConfig(), { ensure: false });
    const sid = mem.store.createSession({ externalId: 's-bare', project: '-Users-me-Devs-b' });
    const id = mem.store.createObservation({ sessionId: sid, kind: 'note', content: 'x' });
    mem.close();

    await cmdPromote([String(id), '--as']);
    expect(process.exitCode).toBe(1);
    expect(outLines.join('')).toContain('non-empty');

    const mem2 = await openMemory(loadConfig(), { ensure: false });
    expect(mem2.store.getObservation(id)?.sessionId).toBe(sid); // untouched
    mem2.close();
  });

  it('promote resolves the id even when --as precedes it', async () => {
    process.env.ABS_EMBED_DIM = '384';
    const mem = await openMemory(loadConfig(), { ensure: false });
    const sid = mem.store.createSession({ externalId: 's-order', project: '-Users-me-Devs-o' });
    const id = mem.store.createObservation({ sessionId: sid, kind: 'lesson', content: 'orig' });
    mem.store.indexFts(id, 'orig');
    mem.close();

    await cmdPromote(['--as', 'curated lesson', String(id), '--json']);
    const o = JSON.parse(outLines.join('')) as { id: number; curated: boolean; newId: number };
    expect(o).toMatchObject({ id, curated: true, applied: true });
    expect(o.newId).toBeGreaterThan(0);
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

describe('resolveHarnesses — --harness flag resolution (install-hooks path)', () => {
  // resolveHarnesses prints the refusal via out()→process.stdout and sets
  // process.exitCode; spy on stdout and reset exitCode like the other cmd suites.
  let outLines: string[];

  beforeEach(() => {
    outLines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      outLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('an unknown --harness id refuses with a non-zero exit and an "unknown harness" message', () => {
    const result = resolveHarnesses(['--harness', 'no-such-harness']);
    expect(result).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(outLines.join('')).toContain("unknown harness 'no-such-harness'");
  });

  it('no --harness flag resolves to the default Claude Code adapter (no error, no exit code)', () => {
    const result = resolveHarnesses([]);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result?.[0]?.id).toBe('claude-code');
    // Default path neither prints nor sets a failing exit code.
    expect(outLines.join('')).toBe('');
    expect(process.exitCode).toBe(0);
  });

  it('an explicit --harness claude-code resolves the same qualifying adapter', () => {
    const result = resolveHarnesses(['--harness', 'claude-code']);
    expect(result?.[0]?.id).toBe('claude-code');
    expect(process.exitCode).toBe(0);
  });

  it('a --harness flag with a missing value is an error, not a silent claude-code fallback', () => {
    const result = resolveHarnesses(['setup', '--harness']);
    expect(result).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(outLines.join('')).toContain('--harness requires a harness id value');
  });

  it('a --harness flag followed by another flag is an error (flag-shaped value)', () => {
    const result = resolveHarnesses(['--harness', '--yes']);
    expect(result).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(outLines.join('')).toContain('--harness requires a harness id value');
  });

  it('--harness codex resolves the qualifying Codex adapter (#67)', () => {
    const result = resolveHarnesses(['--harness', 'codex']);
    expect(result?.map((a) => a.id)).toEqual(['codex']);
    expect(process.exitCode).toBe(0);
  });

  // NOTE: the qualify-fail branch (`!qualifies()` → "does not qualify" + exit 1) is
  // NOT unit-testable in Phase 0: defaultRegistry() holds only the claude-code adapter,
  // whose qualifies() is hard-wired to { ok: true }, and resolveHarnesses reads that
  // registry directly (no injection seam). This branch is exercised in Phase 1 when a
  // second, non-qualifying adapter exists. Production code is intentionally left
  // unrefactored — adding a registry-injection seam purely for this test is not warranted.
});

describe('gatherHarnessStatus — per-harness installed/parity rows (#75)', () => {
  // Minimal fake adapter — gatherHarnessStatus only reads id/displayName and calls
  // detect()/qualifies(). Cast through HarnessAdapter so we don't stub the whole contract.
  type Fake = Pick<HarnessAdapter, 'id' | 'displayName' | 'detect' | 'qualifies'>;
  const fakeRegistry = (adapters: Fake[]) => ({
    all: () => adapters as unknown as readonly HarnessAdapter[],
  });

  it('reports installed=true/parity=true for a detected, qualifying harness', async () => {
    const rows = await gatherHarnessStatus(
      fakeRegistry([
        {
          id: 'foo',
          displayName: 'Foo CLI',
          detect: async () => true,
          qualifies: () => ({ ok: true, missing: [] }),
        },
      ]),
    );
    expect(rows).toEqual([{ id: 'foo', displayName: 'Foo CLI', installed: true, parity: true }]);
  });

  it('reports installed=false when detect() resolves false', async () => {
    const rows = await gatherHarnessStatus(
      fakeRegistry([
        {
          id: 'bar',
          displayName: 'Bar CLI',
          detect: async () => false,
          qualifies: () => ({ ok: true, missing: [] }),
        },
      ]),
    );
    expect(rows[0]).toMatchObject({ installed: false, parity: true });
  });

  it('reports parity=false when qualifies().ok is false', async () => {
    const rows = await gatherHarnessStatus(
      fakeRegistry([
        {
          id: 'baz',
          displayName: 'Baz CLI',
          detect: async () => true,
          qualifies: () => ({ ok: false, missing: ['mcp'] }),
        },
      ]),
    );
    expect(rows[0]).toMatchObject({ installed: true, parity: false });
  });

  it('never crashes when detect() throws — surfaces installed=false (non-fatal)', async () => {
    const rows = await gatherHarnessStatus(
      fakeRegistry([
        {
          id: 'boom',
          displayName: 'Boom CLI',
          detect: async () => {
            throw new Error('detect blew up');
          },
          qualifies: () => ({ ok: true, missing: [] }),
        },
      ]),
    );
    expect(rows[0]).toMatchObject({ id: 'boom', installed: false, parity: true });
  });

  it('preserves order and one row per adapter across a mixed registry', async () => {
    const rows = await gatherHarnessStatus(
      fakeRegistry([
        {
          id: 'a',
          displayName: 'A',
          detect: async () => true,
          qualifies: () => ({ ok: true, missing: [] }),
        },
        {
          id: 'b',
          displayName: 'B',
          detect: async () => false,
          qualifies: () => ({ ok: false, missing: ['recall'] }),
        },
      ]),
    );
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.installed)).toEqual([true, false]);
    expect(rows.map((r) => r.parity)).toEqual([true, false]);
  });

  it('the real defaultRegistry yields one row per shipped adapter (all five qualify)', async () => {
    const { defaultRegistry } = await import('../harness/index.js');
    const rows = await gatherHarnessStatus(defaultRegistry());
    expect(rows.map((r) => r.id).sort()).toEqual([
      'claude-code',
      'codex',
      'copilot',
      'gemini',
      'opencode',
    ]);
    // Every shipped adapter is full-parity (qualifies().ok === true).
    expect(rows.every((r) => r.parity)).toBe(true);
  });
});

describe('cmdUninstall — --harness-aware MCP unregister (C2, #67)', () => {
  let dir: string;
  let outLines: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-cli-uninstall-'));
    process.env.ABS_HOME = dir;
    process.env.ABS_EMBED_DIM = '8';
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
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it('--harness codex unregisters the codex MCP binary, never claude', async () => {
    const calls: string[][] = [];
    await cmdUninstall(['--harness', 'codex'], {
      run: (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args.includes('--version'))
          return Promise.resolve({ code: 0, stdout: 'codex', stderr: '' });
        if (args.includes('list'))
          return Promise.resolve({ code: 0, stdout: 'agentbrainsystem: x', stderr: '' });
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    });
    const mcpCalls = calls.filter((c) => c.includes('mcp'));
    expect(mcpCalls.length).toBeGreaterThan(0);
    // Every MCP-unregister invocation targets the codex binary (C2), never claude.
    expect(mcpCalls.every((c) => c[0] === 'codex')).toBe(true);
    expect(outLines.join('')).toContain('Codex CLI');
  });

  it('no --harness flag targets Claude only (regression)', async () => {
    const calls: string[][] = [];
    await cmdUninstall([], {
      run: (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args.includes('--version'))
          return Promise.resolve({ code: 0, stdout: 'claude', stderr: '' });
        if (args.includes('list')) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    });
    const mcpCalls = calls.filter((c) => c.includes('mcp'));
    expect(mcpCalls.every((c) => c[0] === 'claude')).toBe(true);
  });

  // Regression lock for the `adapter.mcpFileManaged` skip branch in cmdUninstall.
  // OpenCode's MCP entry is FILE-managed: its uninstall() removes the config key,
  // and `opencode mcp` has no non-interactive remove — so the CLI unregister path
  // MUST be skipped. The codex/claude tests above only exercise non-file-managed
  // adapters (CLI path), so without this test a future refactor could delete the
  // guard and all other tests would still pass while opencode silently hangs on the
  // interactive `opencode mcp remove`. This pins the guard's three observable effects.
  it('--harness opencode skips the CLI mcp path (file-managed) yet still removes the config entry', async () => {
    const calls: string[][] = [];
    await cmdUninstall(['--harness', 'opencode'], {
      run: (cmd, args) => {
        calls.push([cmd, ...args]);
        // Should never be reached for a file-managed adapter; default benign result.
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    });
    // 1. ZERO CLI `mcp` invocations — the CLI unregister path is skipped entirely
    //    (no `opencode mcp remove`, no `claude mcp ...`, nothing).
    const mcpCalls = calls.filter((c) => c.includes('mcp'));
    expect(mcpCalls).toEqual([]);
    // 2. The file-managed branch's confirmation line is printed.
    expect(outLines.join('')).toContain('MCP server entry removed from OpenCode config');
    // 3. The adapter's uninstall() still ran — its file path reports the removed
    //    capabilities, which only print AFTER `await adapter.uninstall()` returns.
    expect(outLines.join('')).toContain('hooks removed (OpenCode): capture, recall');
  });
});

describe('cmdRemember — global authoring (hermetic, tmp ABS_HOME, real local provider)', () => {
  let dir: string;
  let outLines: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-cli-remember-'));
    process.env.ABS_HOME = dir;
    delete process.env.ABS_EMBED_DIM; // default dim matches the local provider (embeds for real)
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
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it('remember --global writes under the reserved global session', async () => {
    await cmdRemember(['Always pin Node with .nvmrc.', '--global', '--kind', 'lesson', '--json']);
    const o = JSON.parse(outLines.join(''));
    expect(o).toMatchObject({ scope: 'global', kind: 'lesson', applied: true });

    const mem = await openMemory(loadConfig(), { ensure: false });
    const g = mem.store.getSessionByExternalId('__global__');
    const rows = mem.store.listObservations({ sessionId: g?.id });
    expect(rows.some((x) => x.content === 'Always pin Node with .nvmrc.')).toBe(true);
    mem.close();
  });

  it('errors without --global (project authoring stays in MCP/ingest)', async () => {
    await cmdRemember(['some text', '--json']);
    expect(outLines.join('')).toContain('--global');
    expect(process.exitCode).toBe(1);
  });
});

describe('cmdOpencodeCapture / cmdOpencodeRecall (#72, hermetic, real local provider)', () => {
  let dir: string;
  let outLines: string[];
  const SES = 'ses_abc123';
  const PROJ_DIR = '/Users/test/Devs/ChessTrainer';
  const PROJ_SLUG = '-Users-test-Devs-ChessTrainer';

  // Inject a ground-truth provider so the post-capture sweep (#107) stays hermetic:
  // it skips the real refreshIndex (tree-sitter wasm + repo scan) the helper would
  // otherwise run against process.cwd(). `gtNull` resolves nothing (sweep is a no-op);
  // `gtFor(name)` resolves exactly one symbol so a claimed anchor can verify.
  const gtNull: GroundTruthProvider = {
    isAvailable: () => true,
    currentBranch: () => 'main',
    resolveSymbol: () => null,
    resolveFile: () => null,
    close: () => {},
  };
  const gtFor = (name: string): GroundTruthProvider => ({
    ...gtNull,
    resolveSymbol: (n: string): ResolvedSymbol | null =>
      n === name ? { qualifiedName: n, filePath: 'src/x.ts', line: 10, commitSha: 'abc' } : null,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-cli-opencode-'));
    process.env.ABS_HOME = dir;
    delete process.env.ABS_EMBED_DIM; // capture embeds for real (local provider, dim 384)
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
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  function seedDb(): void {
    buildOpencodeDb(join(dir, 'opencode.db'), [
      {
        id: SES,
        directory: PROJ_DIR,
        messages: [
          { id: 'm1', role: 'user', parts: [{ id: 'p1', text: 'how do I castle in chess' }] },
          {
            id: 'm2',
            role: 'assistant',
            parts: [{ id: 'p2', text: 'Castling moves the king two squares toward a rook.' }],
          },
        ],
      },
    ]);
  }

  it('(a) opencode-capture ingests a temp DB → observations under opencode:ses_', async () => {
    seedDb();
    await cmdOpencodeCapture(['--session', SES, '--db', join(dir, 'opencode.db')], {
      groundTruth: gtNull,
    });
    const mem = await openMemory(loadConfig(), { ensure: false });
    const session = mem.store.getSessionByExternalId(`opencode:${SES}`);
    expect(session).not.toBeNull();
    expect(session?.project).toBe(PROJ_SLUG);
    expect(mem.store.listObservations({ project: PROJ_SLUG }).length).toBe(2);
    mem.close();
  });

  it('(b) opencode-capture missing --session → exit 1', async () => {
    await cmdOpencodeCapture([]);
    expect(process.exitCode).toBe(1);
    expect(outLines.join('')).toContain('--session');
  });

  it('(c) opencode-recall with seeded observations → fenced recalled-memory block scoped to project', async () => {
    seedDb();
    await cmdOpencodeCapture(['--session', SES, '--db', join(dir, 'opencode.db')], {
      groundTruth: gtNull,
    });
    outLines = [];
    await cmdOpencodeRecall(['--session', SES, '--cwd', PROJ_DIR]);
    const text = outLines.join('');
    expect(text).toContain('<recalled-memory>');
    expect(text).toContain(`project "${PROJ_SLUG}"`);
    expect(text).toContain('Castling');
  });

  it('(d) opencode-recall on an empty store → prints nothing, exit 0', async () => {
    await cmdOpencodeRecall(['--session', 'ses_none', '--cwd', PROJ_DIR]);
    // first-recall consent notice IS printed even on an empty store (see test g);
    // but recall block alone is empty. Here the notice fires once → assert no recall fence.
    const text = outLines.join('');
    expect(text).not.toContain('<recalled-memory>');
    expect(process.exitCode).toBe(0);
  });

  it('(e) opencode-recall missing --session/--cwd → exit 1', async () => {
    await cmdOpencodeRecall(['--session', SES]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    outLines = [];
    await cmdOpencodeRecall(['--cwd', PROJ_DIR]);
    expect(process.exitCode).toBe(1);
  });

  it('(f) consent: first recall prepends the notice; the second does NOT (flag consumed)', async () => {
    seedDb();
    await cmdOpencodeCapture(['--session', SES, '--db', join(dir, 'opencode.db')], {
      groundTruth: gtNull,
    });
    outLines = [];
    await cmdOpencodeRecall(['--session', SES, '--cwd', PROJ_DIR]);
    const first = outLines.join('');
    expect(first).toContain('agentbrainsystem — memory notice.');
    outLines = [];
    await cmdOpencodeRecall(['--session', SES, '--cwd', PROJ_DIR]);
    const second = outLines.join('');
    expect(second).not.toContain('agentbrainsystem — memory notice.');
    expect(second).toContain('<recalled-memory>'); // recall still works
  });

  it('(g) consent fires even on an otherwise-empty recall (notice alone on the first turn)', async () => {
    await cmdOpencodeRecall(['--session', 'ses_empty', '--cwd', PROJ_DIR]);
    const text = outLines.join('');
    expect(text).toContain('agentbrainsystem — memory notice.');
    expect(text).not.toContain('<recalled-memory>');
  });

  // #107: OpenCode has no SessionEnd, so the capture path must run the same anchor
  // sweep that every other harness gets — claimed → verified against ground truth.
  it('(h) capture sweeps anchors: a claimed anchor becomes verified when ground truth resolves it', async () => {
    // Pre-seed an observation with a CLAIMED anchor in the same tmp store the capture
    // path will open (ABS_HOME=dir), then close so the capture gets its own connection.
    const seed = await openMemory(loadConfig(), { ensure: false });
    const sid = seed.store.createSession({ externalId: 'opencode:pre', project: PROJ_SLUG });
    const obsId = seed.store.createObservation({
      sessionId: sid,
      kind: 'decision',
      content: 'castle must check king-path safety',
    });
    seed.store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'castle',
      filePath: 'src/x.ts',
    });
    expect(seed.store.getAnchorsForObservation(obsId)[0]?.state).toBe('claimed');
    seed.close();

    seedDb();
    // Capture with a provider that resolves `castle` → the post-capture sweep promotes
    // the claimed anchor to verified.
    await cmdOpencodeCapture(['--session', SES, '--db', join(dir, 'opencode.db')], {
      groundTruth: gtFor('castle'),
    });

    let mem = await openMemory(loadConfig(), { ensure: false });
    expect(mem.store.getAnchorsForObservation(obsId)[0]?.state).toBe('verified');
    mem.close();

    // Idempotent: a second capture re-runs the sweep without harm (still verified).
    await cmdOpencodeCapture(['--session', SES, '--db', join(dir, 'opencode.db')], {
      groundTruth: gtFor('castle'),
    });
    mem = await openMemory(loadConfig(), { ensure: false });
    expect(mem.store.getAnchorsForObservation(obsId)[0]?.state).toBe('verified');
    mem.close();
  });
});

describe('cmdDoctor — health check (#101, hermetic, tmp ABS_HOME)', () => {
  let dir: string;
  let outLines: string[];
  let errLines: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-cli-doctor-'));
    process.env.ABS_HOME = dir;
    outLines = [];
    errLines = [];
    // Keep streams separate: stdout carries the JSON report; stderr the hint.
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      outLines.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      errLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ABS_HOME;
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports healthy + exit 0, printing counts, integrity and WAL size', async () => {
    // Fresh empty store: no observations → no drift → healthy.
    const mem = await openMemory(loadConfig(), { ensure: false });
    mem.store.createSession({ externalId: 's1' });
    mem.close();

    await cmdDoctor({ fetchLatest: async () => null });

    const report = JSON.parse(outLines.join(''));
    expect(report.healthy).toBe(true);
    expect(report.integrity.ok).toBe(true);
    expect(report.counts).toMatchObject({ observations: 0, vectors: 0, fts: 0 });
    expect(typeof report.walSizeBytes).toBe('number');
    expect(report.backupPath).toMatch(/\.bak$/);
    expect(process.exitCode).not.toBe(1);
  });

  it('exits non-zero on a drifted index (observations without vectors/FTS)', async () => {
    const mem = await openMemory(loadConfig(), { ensure: false });
    const sid = mem.store.createSession({ externalId: 's1' });
    // Bypass the indexer → an observation with no vector/FTS = a drifted index.
    mem.store.createObservation({ sessionId: sid, kind: 'note', content: 'orphan' });
    mem.close();

    await cmdDoctor({ fetchLatest: async () => null });

    const report = JSON.parse(outLines.join(''));
    expect(report.healthy).toBe(false);
    expect(report.drift).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(errLines.join('')).toMatch(/STALE|drift/i);
  });

  it('surfaces a degraded flag (embed timeout) — unhealthy + exit 1 even with a fresh index (#136)', async () => {
    const mem = await openMemory(loadConfig(), { ensure: false });
    mem.store.createSession({ externalId: 's1' });
    // A stale degraded flag with NO drift/staleness: doctor used to report healthy:true
    // while SessionStart showed "DEGRADED" — the two surfaces contradicting.
    mem.store.setMeta(EMBED_DEGRADED_KEY, '2026-05-26T21:22:46.793Z');
    mem.close();

    await cmdDoctor({ fetchLatest: async () => null });

    const report = JSON.parse(outLines.join(''));
    expect(report.healthy).toBe(false);
    expect(report.drift).toBe(false);
    expect(report.degraded.embedModelTimeoutAt).toBe('2026-05-26T21:22:46.793Z');
    expect(process.exitCode).toBe(1);
    expect(errLines.join('')).toMatch(/degraded/i);
  });

  it('flags an available update + prints the upgrade hint when a newer version is published', async () => {
    const mem = await openMemory(loadConfig(), { ensure: false });
    mem.store.createSession({ externalId: 's1' });
    mem.close();

    await cmdDoctor({ fetchLatest: async () => '999.0.0' });

    const report = JSON.parse(outLines.join(''));
    expect(report.version.updateAvailable).toBe(true);
    expect(report.version.latest).toBe('999.0.0');
    expect(errLines.join('')).toMatch(/update available.*npm i -g agentbrainsystem@latest/is);
  });

  it('stays quiet about updates when offline (probe returns null) or already current', async () => {
    const mem = await openMemory(loadConfig(), { ensure: false });
    mem.store.createSession({ externalId: 's1' });
    mem.close();

    await cmdDoctor({ fetchLatest: async () => null });

    const report = JSON.parse(outLines.join(''));
    expect(report.version.latest).toBeNull();
    expect(report.version.updateAvailable).toBe(false);
    expect(errLines.join('')).not.toMatch(/update available/i);
  });
});

describe('cmdOptimize — run-level cursor advance after the apply loop (#138/#148 §4)', () => {
  let dir: string;
  let home: string;
  let projectRoot: string;
  let slug: string;

  /** Seed consolidate obs (no embedding — candidate-gen reads the store directly). */
  async function seed(opts: { lessons?: string[]; decisions?: string[] }): Promise<void> {
    const mem: Memory = await openMemory(loadConfig(), { ensure: false });
    const s = mem.store.createSession({ externalId: 's-opt', project: slug });
    for (const content of opts.lessons ?? []) {
      mem.store.createObservation({ sessionId: s, kind: 'lesson', content, source: 'consolidate' });
    }
    for (const content of opts.decisions ?? []) {
      mem.store.createObservation({
        sessionId: s,
        kind: 'decision',
        content,
        source: 'consolidate',
      });
    }
    mem.close();
  }

  /** Read a kind's project-scoped optimize cursor (null when unset). */
  async function cursor(kind: 'lesson' | 'decision'): Promise<string | null> {
    const mem = await openMemory(loadConfig(), { ensure: false });
    const v = mem.store.getMeta(optimizeCursorKey(kind, slug));
    mem.close();
    return v;
  }

  /** maxConsolidatedId for a kind in the seeded project. */
  async function maxConsolidated(kind: 'lesson' | 'decision'): Promise<number> {
    const mem = await openMemory(loadConfig(), { ensure: false });
    const v = mem.store.maxConsolidatedId(slug, kind);
    mem.close();
    return v;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-cli-optimize-'));
    home = mkdtempSync(join(tmpdir(), 'abs-cli-optimize-home-'));
    process.env.ABS_HOME = dir;
    process.env.ABS_EMBED_DIM = '8';
    // Redirect the auto-memory write target (defaultClaudeProjectsDir → homedir) into a
    // tmp HOME so applying a lesson candidate never touches the real ~/.claude/projects.
    process.env.HOME = home;
    projectRoot = join(dir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    slug = projectSlug(projectRoot);
    readlineState.answer = () => 'n';
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ABS_HOME;
    delete process.env.ABS_EMBED_DIM;
    delete process.env.HOME;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('bare preview (no --apply) advances NOTHING (no false all-caught-up, C2)', async () => {
    await seed({
      lessons: ['Use bound parameters in every SQL query'],
      decisions: ['Chose SQLite + sqlite-vec over a separate vector DB'],
    });
    await cmdOptimize(['--project', projectRoot]);
    expect(await cursor('lesson')).toBeNull();
    expect(await cursor('decision')).toBeNull();
  });

  it('--apply --yes with all candidates applied advances BOTH kinds', async () => {
    await seed({
      lessons: ['Use bound parameters in every SQL query'],
      decisions: ['Chose SQLite + sqlite-vec over a separate vector DB'],
    });
    await cmdOptimize(['--project', projectRoot, '--apply', '--yes']);
    expect(await cursor('lesson')).toBe(String(await maxConsolidated('lesson')));
    expect(await cursor('decision')).toBe(String(await maxConsolidated('decision')));
  });

  it('--apply with the user declining ALL advances NOTHING (pending-valid non-empty)', async () => {
    await seed({
      lessons: ['Use bound parameters in every SQL query'],
      decisions: ['Chose SQLite + sqlite-vec over a separate vector DB'],
    });
    readlineState.answer = () => 'n'; // decline every prompt
    await cmdOptimize(['--project', projectRoot, '--apply']);
    expect(await cursor('lesson')).toBeNull();
    expect(await cursor('decision')).toBeNull();
  });

  it('--apply mixed (applies lessons, declines decisions) advances ONLY the lesson cursor', async () => {
    await seed({
      lessons: ['Use bound parameters in every SQL query'],
      decisions: ['Chose SQLite + sqlite-vec over a separate vector DB'],
    });
    // The prompt text carries the target path: decisions resolve to CLAUDE.md, lessons
    // to the auto-memory file. Apply the lesson (y), decline the decision (n).
    readlineState.answer = (prompt) => (prompt.toLowerCase().includes('claude.md') ? 'n' : 'y');
    await cmdOptimize(['--project', projectRoot, '--apply']);
    expect(await cursor('lesson')).toBe(String(await maxConsolidated('lesson')));
    expect(await cursor('decision')).toBeNull();
  });

  it('all-curated-out (zero candidates) with --apply STILL advances the kind whose S_kind is non-empty', async () => {
    // A bare CPU-arch token is the high-confidence trivia signal the heuristic drops,
    // so curation yields zero candidates yet S_kind (the consolidate lesson) is non-empty.
    await seed({ lessons: ['aarch64'] });
    await cmdOptimize(['--project', projectRoot, '--apply', '--yes']);
    // Empty keep-set ⇒ survivors empty ⇒ pending-valid empty ⇒ #148 advance.
    expect(await cursor('lesson')).toBe(String(await maxConsolidated('lesson')));
  });

  it('--apply --yes --limit 1 does NOT advance the SLICED-OFF kind cursor (round-2 keep-set guard)', async () => {
    // Both survive curation, so survivingIds carries both ids. Decisions sort first
    // (priority high); --limit 1 keeps ONLY the decision candidate → the lesson
    // candidate is sliced off. The lesson survivor is pending-valid (in keep, absent
    // from any returned candidate), so its cursor must NOT advance.
    await seed({
      lessons: ['Use bound parameters in every SQL query'],
      decisions: ['Chose SQLite + sqlite-vec over a separate vector DB'],
    });
    await cmdOptimize(['--project', projectRoot, '--apply', '--yes', '--limit', '1']);
    // The applied decision advances its cursor…
    expect(await cursor('decision')).toBe(String(await maxConsolidated('decision')));
    // …but the sliced-off lesson stays pinned (the old S_kind − candidateCovered model
    // would have wrongly advanced it).
    expect(await cursor('lesson')).toBeNull();
  });
});
