import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refreshIndex } from '../index/indexer.js';
import { type Memory, openMemory } from '../memory.js';
import { handlePreToolUse } from './pre-tool-use.js';

function git(root: string, ...args: string[]) {
  execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
}

describe('PreToolUse contradiction guard (#29 duplication, native index)', () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-guard-'));
    repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    delete process.env.ABS_GUARD_MODE;
    process.env.ABS_HOME = join(dir, 'abs'); // empty store → decision-surfacing stays silent here
    process.env.ABS_EMBED_DIM = '8';
    process.env.ABS_WASM_DIR = join(__dirname, '../../dist/index/wasm');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ABS_GUARD_MODE;
    delete process.env.ABS_HOME;
    delete process.env.ABS_EMBED_DIM;
    delete process.env.ABS_WASM_DIR;
  });

  /** Write files (relative paths), commit, and refresh the native index. */
  async function seed(files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(repo, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content);
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'seed');
    await refreshIndex(repo);
  }

  it('warns when the action defines a symbol that already exists in another file', async () => {
    await seed({ 'src/util.ts': 'export function helper() {}' });
    const out = await handlePreToolUse({
      cwd: repo,
      toolName: 'Write',
      toolInput: { file_path: join(repo, 'src/new.ts'), content: 'export function helper() {}' },
    });
    expect(out).toBeTruthy();
    const parsed = JSON.parse(out as string);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('helper');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('util.ts');
  });

  it('stays silent when the symbol already lives in the SAME file (just editing it)', async () => {
    await seed({ 'src/util.ts': 'export function helper() {}' });
    const out = await handlePreToolUse({
      cwd: repo,
      toolName: 'Edit',
      toolInput: {
        file_path: join(repo, 'src/util.ts'),
        new_string: 'export function helper() { return 1; }',
      },
    });
    expect(out).toBeUndefined();
  });

  it('blocks (deny) when ABS_GUARD_MODE=block', async () => {
    await seed({ 'src/util.ts': 'export function helper() {}' });
    process.env.ABS_GUARD_MODE = 'block';
    const out = await handlePreToolUse({
      cwd: repo,
      toolName: 'Write',
      toolInput: { file_path: join(repo, 'src/new.ts'), content: 'export function helper() {}' },
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('helper');
  });

  it('fails open (silent) when the cwd is not a git repo (no native index)', async () => {
    const out = await handlePreToolUse({
      cwd: join(dir, 'no-git'),
      toolName: 'Write',
      toolInput: { file_path: join(dir, 'x.ts'), content: 'export function helper() {}' },
    });
    expect(out).toBeUndefined();
  });

  it('ignores non Edit/Write tools and brand-new symbols', async () => {
    await seed({ 'src/util.ts': 'export function helper() {}' });
    expect(
      await handlePreToolUse({ cwd: repo, toolName: 'Bash', toolInput: { command: 'ls' } }),
    ).toBeUndefined();
    expect(
      await handlePreToolUse({
        cwd: repo,
        toolName: 'Write',
        toolInput: {
          file_path: join(repo, 'src/new.ts'),
          content: 'export function brandNew() {}',
        },
      }),
    ).toBeUndefined();
  });
});

describe('PreToolUse decision surfacing (#48 Phase A)', () => {
  let dir: string;
  let mem: Memory;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'abs-guard-ds-'));
    process.env.ABS_HOME = join(dir, 'abs');
    process.env.ABS_EMBED_DIM = '8';
    process.env.ABS_RECALL_SCOPE = 'global';
    delete process.env.ABS_GUARD_MODE;
    mem = await openMemory(undefined, { ensure: false });
  });
  afterEach(() => {
    mem.close();
    delete process.env.ABS_HOME;
    delete process.env.ABS_EMBED_DIM;
    delete process.env.ABS_RECALL_SCOPE;
    delete process.env.ABS_GUARD_MODE;
    rmSync(dir, { recursive: true, force: true });
  });

  function seedDecision(content: string, kind = 'decision'): void {
    const sid = mem.store.createSession({ externalId: 'ds', project: 'P' });
    const id = mem.store.createObservation({ sessionId: sid, kind, content });
    mem.store.indexFts(id, content);
  }

  it('surfaces a decision related to the touched file (warn-only)', async () => {
    seedDecision('We chose Vitest as the test runner; never add Jest.');
    const out = await handlePreToolUse(
      {
        cwd: '/work/p',
        toolName: 'Write',
        toolInput: { file_path: '/work/p/vitest.config.ts', content: 'export default {}' },
      },
      { memory: mem },
    );
    expect(out).toBeTruthy();
    const parsed = JSON.parse(out as string);
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(parsed.hookSpecificOutput.additionalContext).toContain('[decision]');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Vitest');
  });

  it('stays warn-only even under ABS_GUARD_MODE=block (surfacing never blocks)', async () => {
    process.env.ABS_GUARD_MODE = 'block';
    seedDecision('Lesson: prefer the local embedding provider for $0 default.', 'lesson');
    const out = await handlePreToolUse(
      {
        cwd: '/work/p',
        toolName: 'Edit',
        toolInput: { file_path: '/work/p/embedding.ts', new_string: 'x' },
      },
      { memory: mem },
    );
    const parsed = JSON.parse(out as string);
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(parsed.hookSpecificOutput.additionalContext).toContain('[lesson]');
  });

  it('stays silent when no memory relates to the touched file (low FP)', async () => {
    seedDecision('We chose Vitest as the test runner.');
    const out = await handlePreToolUse(
      {
        cwd: '/work/p',
        toolName: 'Write',
        toolInput: { file_path: '/work/p/payments.ts', content: 'export const x = 1' },
      },
      { memory: mem },
    );
    expect(out).toBeUndefined(); // 'payments' does not match the test-runner memory
  });

  it('stays silent when the store has no memory at all', async () => {
    const out = await handlePreToolUse(
      {
        cwd: '/work/p',
        toolName: 'Write',
        toolInput: { file_path: '/work/p/vitest.config.ts', content: 'x' },
      },
      { memory: mem },
    );
    expect(out).toBeUndefined();
  });

  it('surfaces ANY relevant memory kind related to the file — no consolidation required (#1)', async () => {
    // A plain captured user turn (kind=user) now surfaces; previously the lens filtered to
    // decision/lesson and stayed silent until `consolidate`/`remember` ran.
    seedDecision('vitest config matters a lot for the runner', 'user');
    const out = await handlePreToolUse(
      {
        cwd: '/work/p',
        toolName: 'Write',
        toolInput: { file_path: '/work/p/vitest.config.ts', content: 'x' },
      },
      { memory: mem },
    );
    expect(out, 'a user-kind memory related to the file should now surface').toBeTruthy();
    const parsed = JSON.parse(out as string);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('[user]');
  });

  it('fails open (no throw) when store/config init fails — e.g. invalid env (Codex P2)', async () => {
    process.env.ABS_EMBED_PROVIDER = 'not-a-real-provider';
    try {
      const out = await handlePreToolUse({
        cwd: '/work/p',
        toolName: 'Write',
        toolInput: { file_path: '/work/p/vitest.config.ts', content: 'x' },
      });
      expect(out).toBeUndefined();
    } finally {
      delete process.env.ABS_EMBED_PROVIDER;
    }
  });
});
