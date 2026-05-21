import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentBranch } from './git.js';

/** git.ts currentBranch — best-effort, never throws (FR-C1 substrate). */
describe('currentBranch', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-git-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the branch name of a real repo', () => {
    const repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'feat/sample', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
    expect(currentBranch(repo)).toBe('feat/sample');
  });

  it('returns undefined for a non-git directory (offline-safe)', () => {
    expect(currentBranch(dir)).toBeUndefined();
  });

  it('returns undefined for a path that does not exist', () => {
    expect(currentBranch(join(dir, 'nope'))).toBeUndefined();
  });
});
