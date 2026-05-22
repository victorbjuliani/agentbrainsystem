import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Memory, openMemory } from '../memory.js';
import { handlePreToolUse } from './pre-tool-use.js';

/** Seed a minimal code-review-graph at repoRoot with the given (name, file, line) nodes. */
function seedGraph(repoRoot: string, nodes: Array<[string, string, number]>): void {
  const graphDir = join(repoRoot, '.code-review-graph');
  mkdirSync(graphDir, { recursive: true });
  const db = new Database(join(graphDir, 'graph.db'));
  db.prepare(
    'CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, line_start INTEGER)',
  ).run();
  const ins = db.prepare(
    'INSERT INTO nodes (id, kind, name, qualified_name, file_path, line_start) VALUES (?, ?, ?, ?, ?, ?)',
  );
  let i = 1;
  for (const [name, file, line] of nodes) {
    ins.run(i, 'Function', name, name, file, line);
    i++;
  }
  db.close();
}

describe('PreToolUse contradiction guard (#29 duplication)', () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-guard-'));
    repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    delete process.env.ABS_GUARD_MODE;
    // An isolated empty store so the decision-surfacing lens (#48) stays silent here.
    process.env.ABS_HOME = join(dir, 'abs');
    process.env.ABS_EMBED_DIM = '8';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ABS_GUARD_MODE;
    delete process.env.ABS_HOME;
    delete process.env.ABS_EMBED_DIM;
  });

  it('warns when the action defines a symbol that already exists in another file', async () => {
    seedGraph(repo, [['helper', join(repo, 'src/util.ts'), 12]]);
    const out = await handlePreToolUse({
      cwd: repo,
      toolName: 'Write',
      toolInput: { file_path: join(repo, 'src/new.ts'), content: 'export function helper() {}' },
    });
    expect(out).toBeTruthy();
    const parsed = JSON.parse(out as string);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('helper');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('src/util.ts:12');
  });

  it('stays silent when the symbol already lives in the SAME file (just editing it)', async () => {
    const file = join(repo, 'src/util.ts');
    seedGraph(repo, [['helper', file, 12]]);
    const out = await handlePreToolUse({
      cwd: repo,
      toolName: 'Edit',
      toolInput: { file_path: file, new_string: 'export function helper() { return 1; }' },
    });
    expect(out).toBeUndefined();
  });

  it('blocks (deny) when ABS_GUARD_MODE=block', async () => {
    process.env.ABS_GUARD_MODE = 'block';
    seedGraph(repo, [['helper', join(repo, 'src/util.ts'), 5]]);
    const out = await handlePreToolUse({
      cwd: repo,
      toolName: 'Write',
      toolInput: { file_path: join(repo, 'src/new.ts'), content: 'function helper() {}' },
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('helper');
  });

  it('fails open (silent) when there is no graph for the repo', async () => {
    const out = await handlePreToolUse({
      cwd: join(dir, 'no-graph'),
      toolName: 'Write',
      toolInput: { file_path: join(dir, 'x.ts'), content: 'function helper() {}' },
    });
    expect(out).toBeUndefined();
  });

  it('ignores non Edit/Write tools and new symbols', async () => {
    seedGraph(repo, [['helper', join(repo, 'src/util.ts'), 12]]);
    expect(
      await handlePreToolUse({ cwd: repo, toolName: 'Bash', toolInput: { command: 'ls' } }),
    ).toBeUndefined();
    expect(
      await handlePreToolUse({
        cwd: repo,
        toolName: 'Write',
        toolInput: { file_path: join(repo, 'src/new.ts'), content: 'function brandNew() {}' },
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
    process.env.ABS_RECALL_SCOPE = 'global'; // scope itself is covered by #47/scope tests
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

  /** Seed a decision into FTS (no embed) so recallFts can surface it. */
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
    // Warn-only: a context note, never a deny.
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
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined(); // NOT deny
    expect(parsed.hookSpecificOutput.additionalContext).toContain('[lesson]');
  });

  it('stays silent when no decision relates to the touched file (low FP)', async () => {
    seedDecision('We chose Vitest as the test runner.');
    const out = await handlePreToolUse(
      {
        cwd: '/work/p',
        toolName: 'Write',
        toolInput: { file_path: '/work/p/payments.ts', content: 'export const x = 1' },
      },
      { memory: mem },
    );
    expect(out).toBeUndefined(); // 'payments' does not match the test-runner decision
  });

  it('stays silent when the store has no decisions at all', async () => {
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

  it('does not surface non-decision observations (only decision/lesson)', async () => {
    seedDecision('vitest config matters a lot for the runner', 'user'); // kind=user, not decision
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
});
