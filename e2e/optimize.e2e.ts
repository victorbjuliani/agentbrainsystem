/**
 * E2E — consolidate + optimize against the BUILT binary. Covers:
 *   F  consolidate via a fake localhost OpenAI server (dry-run / write / idempotent / --force)
 *   H  optimize preview → apply (decision → CLAUDE.md, backup) + protected-memory guard
 *
 * H depends on F: optimize only consumes consolidated lessons/decisions
 * (`source:consolidate`), so each H case runs `abs consolidate` first. The fake LLM
 * keeps everything $0/offline (no real network).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  abs,
  type E2EHome,
  type FakeLlm,
  FIXTURES_PROJECTS,
  fakeOpenAi,
  makeHome,
  parseJson,
} from './harness.js';

/** The exact JSON shape `distill.ts` parses from the model reply. */
function lessonsJson(items: Array<{ kind: 'lesson' | 'decision'; content: string }>): string {
  return JSON.stringify(items);
}

interface StatusResult {
  counts: { observations: number };
}
const obsCount = async (env: NodeJS.ProcessEnv): Promise<number> =>
  parseJson<StatusResult>((await abs(['status'], { env })).stdout).counts.observations;

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

describe('F — consolidate via a fake OpenAI-compatible endpoint', () => {
  beforeEach(async () => {
    fake = await fakeOpenAi(
      lessonsJson([
        { kind: 'decision', content: 'Adopt Vitest as the canonical test runner; never add Jest.' },
        {
          kind: 'lesson',
          content:
            'Staging DB resets at 2am UTC — seed fixtures in a setup hook, not from staging.',
        },
      ]),
    );
  });

  function llmEnv(): NodeJS.ProcessEnv {
    return { ...h.env, ABS_LLM_BASE_URL: (fake as FakeLlm).baseUrl, ABS_LLM_MODEL: 'stub' };
  }

  it('dry-run calls the LLM once and writes nothing; a real run writes recallable lessons', async () => {
    await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
    const before = await obsCount(h.env);

    const dry = await abs(['consolidate', '--dry-run'], { env: llmEnv() });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('would write');
    expect(dry.stdout).toContain('(dry-run — nothing was written)');
    expect((fake as FakeLlm).calls()).toBe(1);
    expect(await obsCount(h.env)).toBe(before); // nothing written

    const run = await abs(['consolidate'], { env: llmEnv() });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('wrote');
    expect(await obsCount(h.env)).toBe(before + 2); // two distilled items stored
  });

  it('is idempotent (a consolidated session is skipped) and --force re-distills it', async () => {
    await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
    await abs(['consolidate'], { env: llmEnv() });
    const callsAfterFirst = (fake as FakeLlm).calls();

    const again = await abs(['consolidate'], { env: llmEnv() });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('skipped');
    expect((fake as FakeLlm).calls()).toBe(callsAfterFirst); // no new LLM call

    const forced = await abs(['consolidate', '--session', '1', '--force'], { env: llmEnv() });
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain('wrote');
    expect((fake as FakeLlm).calls()).toBe(callsAfterFirst + 1); // re-distilled
  });
});

describe('H — optimize (consumes consolidated memory)', () => {
  /** Ingest + consolidate so the store holds a decision and a lesson to optimize. */
  async function seedConsolidated(): Promise<void> {
    fake = await fakeOpenAi(
      lessonsJson([
        {
          kind: 'decision',
          content: 'Bind the UI to 127.0.0.1 only; never expose the memory graph on 0.0.0.0.',
        },
        {
          kind: 'lesson',
          content: 'Local embeddings stay offline after the first model cache — keep them default.',
        },
      ]),
    );
    await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
    const run = await abs(['consolidate'], {
      env: { ...h.env, ABS_LLM_BASE_URL: fake.baseUrl, ABS_LLM_MODEL: 'stub' },
    });
    expect(run.code, run.stderr).toBe(0);
  }

  it('preview writes nothing; --apply writes CLAUDE.md with a backup', async () => {
    await seedConsolidated();
    const projectRoot = join(h.home, 'proj');
    mkdirSync(projectRoot, { recursive: true });
    const claudeMd = join(projectRoot, 'CLAUDE.md');
    const seed = '# CLAUDE.md\n\nseed content.\n';
    writeFileSync(claudeMd, seed);

    // Preview (no LLM env → heuristic, $0) writes nothing.
    const preview = await abs(['optimize', '--project', projectRoot], { env: h.env });
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('claude-md');
    expect(preview.stdout).toContain('preview — nothing written');
    expect(readFileSync(claudeMd, 'utf8')).toBe(seed);

    // Apply all candidates non-interactively.
    const applied = await abs(['optimize', '--project', projectRoot, '--apply', '--yes'], {
      env: h.env,
    });
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.stdout).toContain('applied');
    expect(readFileSync(claudeMd, 'utf8')).not.toBe(seed); // CLAUDE.md changed
    const backups = readdirSync(projectRoot).filter((f) => f.startsWith('CLAUDE.md.abs-bak-'));
    expect(backups.length).toBeGreaterThanOrEqual(1); // backup-first
  });

  it('refuses to overwrite a protected (type: user) auto-memory entry', async () => {
    await seedConsolidated();
    const projectRoot = join(h.home, 'proj');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# CLAUDE.md\n');

    // Pre-create the EXACT auto-memory target the lesson candidate would write,
    // marked type:user → the fail-closed guard must refuse it.
    const slug = resolve(projectRoot).split(sep).join('-');
    const memDir = join(h.home, '.claude', 'projects', slug, 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, 'consolidated-lessons.md'),
      '---\nmetadata:\n  type: user\n---\n\nhand-written user memory — do not touch.\n',
    );

    const applied = await abs(['optimize', '--project', projectRoot, '--apply', '--yes'], {
      env: h.env,
    });
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.stdout).toContain('protected-memory-type');
    // The protected file is untouched.
    expect(readFileSync(join(memDir, 'consolidated-lessons.md'), 'utf8')).toContain(
      'hand-written user memory',
    );
  });
});
