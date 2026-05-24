import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dirtyFiles, headCommit, lsFiles, repoRoot } from './git.js';

function git(root: string, ...args: string[]) {
  execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
}

describe('index/git helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-git-'));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, 'a.ts'), 'export function foo(){}');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('repoRoot resolves the toplevel', () => {
    expect(repoRoot(dir)).toBeTruthy();
  });
  it('repoRoot is undefined outside a repo', () => {
    const out = mkdtempSync(join(tmpdir(), 'abs-nogit-'));
    expect(repoRoot(out)).toBeUndefined();
    rmSync(out, { recursive: true, force: true });
  });
  it('headCommit returns a sha', () => {
    expect(headCommit(dir)).toMatch(/^[0-9a-f]{7,}/);
  });
  it('lsFiles lists tracked files', () => {
    expect(lsFiles(dir)).toContain('a.ts');
  });
  it('dirtyFiles reports modified + untracked', () => {
    writeFileSync(join(dir, 'a.ts'), 'export function foo(){}\nexport function bar(){}');
    writeFileSync(join(dir, 'b.ts'), 'export const x=1');
    expect(dirtyFiles(dir)).toEqual(expect.arrayContaining(['a.ts', 'b.ts']));
  });
  it('dirtyFiles indexes the destination of a staged rename', () => {
    git(dir, 'mv', 'a.ts', 'renamed.ts');
    expect(dirtyFiles(dir)).toContain('renamed.ts');
  });
});
