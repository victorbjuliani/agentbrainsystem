import { mkdtempSync, rmSync } from 'node:fs';
import * as nodeFsp from 'node:fs/promises';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ApplierFs, GatedApplier } from './applier.js';
import { autoMemoryDir, autoMemoryEntryPath, claudeMdPath } from './targets.js';
import type { OptimizeCandidate, OptimizeTarget } from './types.js';

let dir: string;
let projectRoot: string;
let projectsDir: string;
let applier: GatedApplier;

function candidate(target: OptimizeTarget, proposedText: string): OptimizeCandidate {
  return {
    id: 'cand-1',
    target,
    title: 't',
    rationale: 'r',
    diff: '',
    proposedText,
    evidenceIds: [1],
    priority: 'high',
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-applier-'));
  projectRoot = join(dir, 'project');
  projectsDir = join(dir, 'projects');
  applier = new GatedApplier();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A real fs whose `rename` fails once — drives the rollback path deterministically. */
function fsWithFailingRename(): ApplierFs {
  return {
    stat: nodeFsp.stat,
    readFile: nodeFsp.readFile,
    writeFile: nodeFsp.writeFile,
    copyFile: nodeFsp.copyFile,
    mkdir: nodeFsp.mkdir,
    rm: nodeFsp.rm,
    rename: () => Promise.reject(new Error('boom on rename')),
  };
}

describe('GatedApplier — allowlist enforcement', () => {
  it('REFUSES a forbidden target (source file) without writing', async () => {
    const target: OptimizeTarget = { kind: 'claude-md', absPath: join(projectRoot, 'src/x.ts') };
    const result = await applier.apply(candidate(target, '\nx\n'), { projectRoot, projectsDir });
    expect(result.applied).toBe(false);
    expect(result.refused).toBe('forbidden-target');
  });

  it('REFUSES AGENTS.md', async () => {
    const target: OptimizeTarget = { kind: 'claude-md', absPath: join(projectRoot, 'AGENTS.md') };
    const result = await applier.apply(candidate(target, '\nx\n'), { projectRoot, projectsDir });
    expect(result.refused).toBe('forbidden-target');
  });
});

describe('GatedApplier — CLAUDE.md applier', () => {
  it('creates CLAUDE.md when absent (no backup, file created)', async () => {
    const target: OptimizeTarget = { kind: 'claude-md', absPath: claudeMdPath(projectRoot) };
    const result = await applier.apply(candidate(target, '\n- new rule\n'), {
      projectRoot,
      projectsDir,
    });
    expect(result.applied).toBe(true);
    expect(result.backupPath).toBeUndefined();
    expect(await readFile(claudeMdPath(projectRoot), 'utf8')).toBe('\n- new rule\n');
  });

  it('appends to an existing CLAUDE.md and leaves a backup', async () => {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(claudeMdPath(projectRoot), '# Project\n', 'utf8');
    const target: OptimizeTarget = { kind: 'claude-md', absPath: claudeMdPath(projectRoot) };

    const result = await applier.apply(candidate(target, '\n- appended\n'), {
      projectRoot,
      projectsDir,
    });

    expect(result.applied).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(await readFile(claudeMdPath(projectRoot), 'utf8')).toBe('# Project\n\n- appended\n');
    // The backup holds the original bytes.
    if (result.backupPath) {
      expect(await readFile(result.backupPath, 'utf8')).toBe('# Project\n');
    }
  });
});

describe('GatedApplier — auto-memory applier + slug mapping', () => {
  it('writes a project-type auto-memory entry under the slug dir', async () => {
    const absPath = autoMemoryEntryPath(projectRoot, projectsDir, 'consolidated-lessons.md');
    const target: OptimizeTarget = { kind: 'auto-memory', absPath, memoryType: 'project' };
    const result = await applier.apply(candidate(target, '\n- lesson\n'), {
      projectRoot,
      projectsDir,
    });
    expect(result.applied).toBe(true);
    expect(result.absPath).toBe(absPath);
    expect(await readFile(absPath, 'utf8')).toContain('- lesson');
  });
});

describe('GatedApplier — stale candidate guard', () => {
  it('REFUSES when the file changed since the diff was generated', async () => {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(claudeMdPath(projectRoot), 'current content\n', 'utf8');
    const target: OptimizeTarget = { kind: 'claude-md', absPath: claudeMdPath(projectRoot) };

    const result = await applier.apply(candidate(target, '\n- x\n'), {
      projectRoot,
      projectsDir,
      expectedBaseContent: 'STALE content\n',
    });

    expect(result.applied).toBe(false);
    expect(result.refused).toBe('target-modified');
    // File untouched.
    expect(await readFile(claudeMdPath(projectRoot), 'utf8')).toBe('current content\n');
  });
});

describe('GatedApplier — rollback on mid-write failure', () => {
  it('leaves an EXISTING file byte-for-byte intact when the write fails', async () => {
    await mkdir(projectRoot, { recursive: true });
    const original = '# Project\n\noriginal body\n';
    await writeFile(claudeMdPath(projectRoot), original, 'utf8');
    const target: OptimizeTarget = { kind: 'claude-md', absPath: claudeMdPath(projectRoot) };

    // Fail the atomic rename step — backup has been taken, target untouched yet.
    const failing = new GatedApplier(fsWithFailingRename());

    await expect(
      failing.apply(candidate(target, '\n- appended\n'), { projectRoot, projectsDir }),
    ).rejects.toThrow(/boom on rename/);

    // The original file must be unchanged.
    expect(await readFile(claudeMdPath(projectRoot), 'utf8')).toBe(original);
    // No leftover backup or temp files in the dir.
    const entries = await readdir(projectRoot);
    expect(entries.filter((e) => e.includes('abs-bak') || e.includes('abs-tmp'))).toEqual([]);
  });

  it('leaves NO file behind when creating a new file fails mid-write', async () => {
    const target: OptimizeTarget = { kind: 'claude-md', absPath: claudeMdPath(projectRoot) };
    const failing = new GatedApplier(fsWithFailingRename());

    await expect(
      failing.apply(candidate(target, '\n- new\n'), { projectRoot, projectsDir }),
    ).rejects.toThrow(/boom on rename/);

    const { existsSync } = await import('node:fs');
    expect(existsSync(claudeMdPath(projectRoot))).toBe(false);
    // No leftover temp files.
    const entries = await readdir(projectRoot).catch(() => [] as string[]);
    expect(entries.filter((e) => e.includes('abs-tmp'))).toEqual([]);
  });
});
