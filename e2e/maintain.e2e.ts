/**
 * E2E — the auto-distill cadence `abs maintain --auto` against the BUILT binary (#138).
 *
 * Covers the manual lane of the cadence end to end with a fake localhost OpenAI server:
 *   ingest a session → `abs maintain --auto` →
 *     - consolidate wrote durable `source='consolidate'` rows (observation count grew),
 *     - the auto-memory `consolidated-lessons.md` entry + `MEMORY.md` pointer were written,
 *     - the project's git-tracked `CLAUDE.md` was NOT created/modified (decisions stay manual),
 *     - a second `abs maintain --auto` is idempotent (consolidate skips; no new durable rows).
 *
 * The cadence scopes its optimize pass to `process.cwd()` (the SAME `projectSlug` resolver
 * candidate-gen uses), so the maintain process is spawned with `cwd: projectRoot` — the same
 * dir the seeded transcript's turns ran in. That makes the consolidated lessons of THIS
 * project the ones the cadence promotes. The fake LLM keeps everything $0/offline.
 *
 * The DETACHED SessionEnd spawn path (cadence-due eval → `spawn(... detached)`) is exercised by
 * the Phase 6 unit tests with a spawn seam; here we drive the runner directly via the built
 * `abs maintain --auto` so the assertions are deterministic (no bounded-wait flakiness).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  abs,
  type E2EHome,
  type FakeLlm,
  fakeOpenAi,
  ingestFixtures,
  makeHome,
  parseJson,
} from './harness.js';

/** The exact JSON shape `distill.ts` parses from the model reply (consolidate). */
function lessonsJson(items: Array<{ kind: 'lesson' | 'decision'; content: string }>): string {
  return JSON.stringify(items);
}

interface StatusResult {
  counts: { observations: number };
}
const obsCount = async (env: NodeJS.ProcessEnv): Promise<number> =>
  parseJson<StatusResult>((await abs(['status'], { env })).stdout).counts.observations;

/**
 * The auto-memory dir the cadence writes into for `projectRoot`, under the harness HOME.
 * Mirrors `autoMemoryDir(projectRoot, projectsDir)`: `<HOME>/.claude/projects/<slug>/memory`.
 * The slug is the absolute project path with every separator replaced by `-`. `projectRoot`
 * MUST be the realpath (see `makeProjectRoot`) so this slug matches `projectSlug(process.cwd())`.
 */
function autoMemoryDirFor(home: string, projectRoot: string): string {
  const slug = projectRoot.split('/').join('-');
  return join(home, '.claude', 'projects', slug, 'memory');
}

/**
 * Create the project dir and return its REALPATH. The cadence scopes its optimize pass to
 * `process.cwd()`, and a spawned process' `process.cwd()` is the resolved real path — on macOS
 * the temp HOME lives under the `/var → /private/var` symlink, so the literal `join(home,'proj')`
 * (slug `-var-…`) would NOT match `projectSlug(process.cwd())` (slug `-private-var-…`). Resolving
 * the symlink HERE makes the transcript `cwd`, the spawn `cwd`, and the slug agree byte-for-byte.
 */
function makeProjectRoot(home: string): string {
  const root = join(home, 'proj');
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

let h: E2EHome;
let fake: FakeLlm | undefined;
beforeEach(() => {
  h = makeHome();
});
afterEach(() => {
  fake?.stop();
  fake = undefined;
  h.cleanup();
});

describe('M — auto-distill cadence `abs maintain --auto`', () => {
  /**
   * Seed a session whose turns ran in `projectRoot` so its consolidated lessons land under
   * `projectSlug(projectRoot)` — the same project the cadence (run with `cwd: projectRoot`)
   * promotes. Returns the LLM env (fake OpenAI server) the cadence needs to consolidate.
   */
  async function seedSession(projectRoot: string): Promise<NodeJS.ProcessEnv> {
    fake = await fakeOpenAi(
      lessonsJson([
        {
          kind: 'lesson',
          content: 'Local embeddings stay offline after the first model cache — keep them default.',
        },
        {
          kind: 'decision',
          content: 'Bind the UI to 127.0.0.1 only; never expose the memory graph on 0.0.0.0.',
        },
      ]),
    );
    const projectsDir = join(h.home, 'transcripts');
    const sessDir = join(projectsDir, 'demo');
    mkdirSync(sessDir, { recursive: true });
    const turn = (role: 'user' | 'assistant', content: string): string =>
      JSON.stringify({
        type: role,
        sessionId: 'sessMaintain',
        cwd: projectRoot,
        message: { role, content },
      });
    writeFileSync(
      join(sessDir, 'sessMaintain.jsonl'),
      `${turn('user', 'How should we bind the UI server and handle embeddings?')}\n${turn(
        'assistant',
        'Bind the UI to 127.0.0.1 only, never 0.0.0.0. Local embeddings stay offline after the first model cache.',
      )}\n`,
    );
    const ingest = await ingestFixtures(h.env, projectsDir);
    expect(ingest.code, ingest.stderr).toBe(0);
    return { ...h.env, ABS_LLM_BASE_URL: (fake as FakeLlm).baseUrl, ABS_LLM_MODEL: 'stub' };
  }

  /**
   * Seed (and ingest) a SECOND distinct session in the same project. Its turns ran in
   * `projectRoot` too, so its consolidated lesson lands under the same slug — giving the
   * NEXT cadence run a brand-new session to consolidate (a new `source='consolidate'`
   * row with a new id). Used by the duplication regression: the 2nd run must append only
   * the NEW lesson, never re-append the 1st run's already-promoted one.
   */
  async function seedSecondSession(projectRoot: string, sessionId: string): Promise<void> {
    const projectsDir = join(h.home, 'transcripts');
    const sessDir = join(projectsDir, 'demo2');
    mkdirSync(sessDir, { recursive: true });
    const turn = (role: 'user' | 'assistant', content: string): string =>
      JSON.stringify({ type: role, sessionId, cwd: projectRoot, message: { role, content } });
    writeFileSync(
      join(sessDir, `${sessionId}.jsonl`),
      `${turn('user', 'Remind me how we handle embeddings and the UI bind address?')}\n${turn(
        'assistant',
        'Local embeddings stay offline after the first model cache; bind the UI to 127.0.0.1 only.',
      )}\n`,
    );
    const ingest = await ingestFixtures(h.env, projectsDir);
    expect(ingest.code, ingest.stderr).toBe(0);
  }

  it('consolidates + auto-applies the lesson to auto-memory, never touches CLAUDE.md, and is idempotent', async () => {
    const projectRoot = makeProjectRoot(h.home);
    const llmEnv = await seedSession(projectRoot);

    const before = await obsCount(h.env);

    // First cadence run: consolidate → auto-apply auto-memory only.
    const run = await abs(['maintain', '--auto'], { env: llmEnv, cwd: projectRoot });
    expect(run.code, run.stderr).toBe(0);

    // (1) Consolidate wrote durable `source='consolidate'` rows → the total observation
    //     count grew by the two distilled items (one lesson + one decision).
    const afterConsolidate = await obsCount(h.env);
    expect(afterConsolidate).toBe(before + 2);

    // (2) The auto-memory entry + the MEMORY.md index pointer were written (the #140 path).
    const memDir = autoMemoryDirFor(h.home, projectRoot);
    const lessonsFile = join(memDir, 'consolidated-lessons.md');
    const memoryIndex = join(memDir, 'MEMORY.md');
    expect(existsSync(lessonsFile)).toBe(true);
    const lessons = readFileSync(lessonsFile, 'utf8');
    // The managed `project`-type frontmatter shape Claude Code loads natively (#140).
    expect(lessons).toContain('name: consolidated-lessons');
    expect(lessons).toContain('type: project');
    expect(lessons).toContain('Local embeddings stay offline');
    expect(existsSync(memoryIndex)).toBe(true);
    // The additive pointer line targets the entry by its markdown LINK TARGET.
    expect(readFileSync(memoryIndex, 'utf8')).toContain('](consolidated-lessons.md)');

    // (3) The git-tracked project CLAUDE.md was NEVER created (the decision stays manual).
    expect(existsSync(join(projectRoot, 'CLAUDE.md'))).toBe(false);
    // The skipped decision is reported on stderr for the manual `abs optimize`.
    expect(run.stderr).toContain('pending manual `abs optimize`');

    // (4) Idempotent: a second cadence run consolidates nothing new (the session is already
    //     consolidated) → no new durable rows. The lesson entry stays present (no corruption).
    const second = await abs(['maintain', '--auto'], { env: llmEnv, cwd: projectRoot });
    expect(second.code, second.stderr).toBe(0);
    expect(await obsCount(h.env)).toBe(afterConsolidate); // consolidate skipped → count stable
    expect(existsSync(lessonsFile)).toBe(true);
    expect(existsSync(join(projectRoot, 'CLAUDE.md'))).toBe(false);
  });

  it('two cadence runs over DISTINCT sessions never duplicate a `_(memory #id)_` bullet (FIX1)', async () => {
    const projectRoot = makeProjectRoot(h.home);
    const llmEnv = await seedSession(projectRoot);

    // First cadence run: consolidate session #1 → auto-apply its lesson to auto-memory.
    const run1 = await abs(['maintain', '--auto'], { env: llmEnv, cwd: projectRoot });
    expect(run1.code, run1.stderr).toBe(0);

    const memDir = autoMemoryDirFor(h.home, projectRoot);
    const lessonsFile = join(memDir, 'consolidated-lessons.md');
    expect(existsSync(lessonsFile)).toBe(true);

    // Seed + ingest a SECOND distinct session, then run the cadence again so it
    // consolidates the NEW session (a fresh `source='consolidate'` lesson row).
    await seedSecondSession(projectRoot, 'sessMaintain2');
    const run2 = await abs(['maintain', '--auto'], { env: llmEnv, cwd: projectRoot });
    expect(run2.code, run2.stderr).toBe(0);

    // The regression guard: every `_(memory #<id>)_` marker appears AT MOST ONCE. Before
    // the cursor filter, the 2nd run re-clustered session #1's already-promoted lesson and
    // the append applier wrote its bullet a second time → a duplicated marker here.
    const lessons = readFileSync(lessonsFile, 'utf8');
    const markers = [...lessons.matchAll(/_\(memory #(\d+)\)_/g)].map((m) => m[1]);
    expect(markers.length).toBeGreaterThan(0); // at least the two runs' lessons were written
    const seen = new Map<string, number>();
    for (const id of markers) seen.set(id as string, (seen.get(id as string) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
    expect(duplicated, `duplicated memory markers: ${JSON.stringify(duplicated)}`).toEqual([]);
    // Two DISTINCT lesson rows were promoted across the two runs (no collapse, no dup).
    expect(seen.size).toBe(2);
  });

  it('is a benign no-op with no LLM configured (cannot consolidate, writes nothing)', async () => {
    const projectRoot = makeProjectRoot(h.home);
    await seedSession(projectRoot); // seeds the session, but we run WITHOUT the LLM env
    const before = await obsCount(h.env);

    // No ABS_LLM_* in `h.env` → the cadence short-circuits on the no-LLM gate, exit 0.
    const run = await abs(['maintain', '--auto'], { env: h.env, cwd: projectRoot });
    expect(run.code, run.stderr).toBe(0);

    expect(await obsCount(h.env)).toBe(before); // nothing consolidated
    expect(existsSync(autoMemoryDirFor(h.home, projectRoot))).toBe(false); // nothing promoted
    expect(existsSync(join(projectRoot, 'CLAUDE.md'))).toBe(false);
  });
});
