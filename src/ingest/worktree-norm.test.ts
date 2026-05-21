import { describe, expect, it } from 'vitest';
import { extractToolAnchors, normalizeWorktreePath } from './claude-jsonl.js';

/** FR-C2 (#32): ephemeral worktree paths collapse to the canonical main-repo path. */
describe('normalizeWorktreePath', () => {
  it('collapses a .worktrees/<branch> path to the repo file', () => {
    expect(normalizeWorktreePath('/r/.worktrees/feat-x/src/mod.ts')).toBe('/r/src/mod.ts');
  });

  it('collapses a .claude/worktrees/<id> path to the repo file', () => {
    expect(normalizeWorktreePath('/r/.claude/worktrees/agent-abc/src/a/b.ts')).toBe(
      '/r/src/a/b.ts',
    );
  });

  it('passes a normal path through unchanged', () => {
    expect(normalizeWorktreePath('/r/src/mod.ts')).toBe('/r/src/mod.ts');
  });

  it('extractToolAnchors anchors a worktree edit to the canonical file', () => {
    const seeds = extractToolAnchors([
      {
        type: 'tool_use',
        name: 'Edit',
        input: {
          file_path: '/r/.worktrees/feat-x/src/mod.ts',
          new_string: 'export function helper() {}',
        },
      },
    ]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.filePath).toBe('/r/src/mod.ts'); // not the worktree path
    expect(seeds[0]?.symbols).toContain('helper');
  });
});
