import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('PreToolUse contradiction guard (#29)', () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-guard-'));
    repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    delete process.env.ABS_GUARD_MODE;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ABS_GUARD_MODE;
  });

  it('warns when the action defines a symbol that already exists in another file', () => {
    seedGraph(repo, [['helper', join(repo, 'src/util.ts'), 12]]);
    const out = handlePreToolUse({
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

  it('stays silent when the symbol already lives in the SAME file (just editing it)', () => {
    const file = join(repo, 'src/util.ts');
    seedGraph(repo, [['helper', file, 12]]);
    const out = handlePreToolUse({
      cwd: repo,
      toolName: 'Edit',
      toolInput: { file_path: file, new_string: 'export function helper() { return 1; }' },
    });
    expect(out).toBeUndefined();
  });

  it('blocks (deny) when ABS_GUARD_MODE=block', () => {
    process.env.ABS_GUARD_MODE = 'block';
    seedGraph(repo, [['helper', join(repo, 'src/util.ts'), 5]]);
    const out = handlePreToolUse({
      cwd: repo,
      toolName: 'Write',
      toolInput: { file_path: join(repo, 'src/new.ts'), content: 'function helper() {}' },
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('helper');
  });

  it('fails open (silent) when there is no graph for the repo', () => {
    const out = handlePreToolUse({
      cwd: join(dir, 'no-graph'),
      toolName: 'Write',
      toolInput: { file_path: join(dir, 'x.ts'), content: 'function helper() {}' },
    });
    expect(out).toBeUndefined();
  });

  it('ignores non Edit/Write tools and new symbols', () => {
    seedGraph(repo, [['helper', join(repo, 'src/util.ts'), 12]]);
    expect(
      handlePreToolUse({ cwd: repo, toolName: 'Bash', toolInput: { command: 'ls' } }),
    ).toBeUndefined();
    expect(
      handlePreToolUse({
        cwd: repo,
        toolName: 'Write',
        toolInput: { file_path: join(repo, 'src/new.ts'), content: 'function brandNew() {}' },
      }),
    ).toBeUndefined();
  });
});
