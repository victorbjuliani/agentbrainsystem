import { mkdtempSync, rmSync } from 'node:fs';
import * as nodeFsp from 'node:fs/promises';
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ApplierFs, GatedApplier, MAX_BACKUPS_PER_FILE } from './applier.js';
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
    baseContent: '',
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
    lstat: nodeFsp.lstat,
    readFile: nodeFsp.readFile,
    writeFile: nodeFsp.writeFile,
    copyFile: nodeFsp.copyFile,
    chmod: nodeFsp.chmod,
    mkdir: nodeFsp.mkdir,
    rm: nodeFsp.rm,
    readdir: nodeFsp.readdir,
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

describe('GatedApplier — backup retention (#114)', () => {
  it('keeps at most MAX_BACKUPS_PER_FILE backups, pruning the oldest', async () => {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(claudeMdPath(projectRoot), '# Project\n', 'utf8');
    const target: OptimizeTarget = { kind: 'claude-md', absPath: claudeMdPath(projectRoot) };

    // N+2 applies → N+2 backups created, but prune caps each file at N.
    for (let i = 0; i < MAX_BACKUPS_PER_FILE + 2; i++) {
      const result = await applier.apply(candidate(target, `\n- line ${i}\n`), {
        projectRoot,
        projectsDir,
      });
      expect(result.applied).toBe(true);
      // The backup stamp is millisecond-resolution; space applies so each gets a
      // distinct name (COPYFILE_EXCL would otherwise collide within one ms).
      await new Promise((r) => setTimeout(r, 5));
    }

    const backups = (await readdir(projectRoot)).filter((n) => n.startsWith('CLAUDE.md.abs-bak-'));
    expect(backups.length).toBe(MAX_BACKUPS_PER_FILE);
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

describe('GatedApplier — symlink refusal', () => {
  it('REFUSES a symlinked CLAUDE.md and leaves the link destination untouched', async () => {
    await mkdir(projectRoot, { recursive: true });
    // A sensitive file the attacker wants written; plant a symlink at the target
    // pointing at it (lexical path.resolve would otherwise follow it on write).
    const secret = join(dir, 'authorized_keys');
    await writeFile(secret, 'ssh-rsa ORIGINAL\n', 'utf8');
    await symlink(secret, claudeMdPath(projectRoot));
    const target: OptimizeTarget = { kind: 'claude-md', absPath: claudeMdPath(projectRoot) };

    const result = await applier.apply(candidate(target, '\n- malicious\n'), {
      projectRoot,
      projectsDir,
    });

    expect(result.applied).toBe(false);
    expect(result.refused).toBe('symlink-target');
    // The symlink's destination is byte-for-byte unchanged.
    expect(await readFile(secret, 'utf8')).toBe('ssh-rsa ORIGINAL\n');
    // The target itself is still a symlink (not replaced with a regular file).
    expect((await lstat(claudeMdPath(projectRoot))).isSymbolicLink()).toBe(true);
  });

  it('REFUSES a symlinked auto-memory entry without following it', async () => {
    const secret = join(dir, 'zshrc');
    await writeFile(secret, 'export ORIGINAL=1\n', 'utf8');
    const absPath = autoMemoryEntryPath(projectRoot, projectsDir, 'consolidated-lessons.md');
    await mkdir(autoMemoryDir(projectRoot, projectsDir), { recursive: true });
    await symlink(secret, absPath);
    const target: OptimizeTarget = { kind: 'auto-memory', absPath, memoryType: 'project' };

    const result = await applier.apply(candidate(target, '\n- lesson\n'), {
      projectRoot,
      projectsDir,
    });

    expect(result.applied).toBe(false);
    expect(result.refused).toBe('symlink-target');
    expect(await readFile(secret, 'utf8')).toBe('export ORIGINAL=1\n');
  });
});

describe('GatedApplier — backup file permissions', () => {
  it('writes the backup with mode 0o600 and still restores on rollback', async () => {
    await mkdir(projectRoot, { recursive: true });
    const original = '# Project\nsensitive\n';
    await writeFile(claudeMdPath(projectRoot), original, 'utf8');
    const target: OptimizeTarget = { kind: 'claude-md', absPath: claudeMdPath(projectRoot) };

    const result = await applier.apply(candidate(target, '\n- appended\n'), {
      projectRoot,
      projectsDir,
    });

    expect(result.applied).toBe(true);
    expect(result.backupPath).toBeDefined();
    if (result.backupPath) {
      const mode = (await lstat(result.backupPath)).mode & 0o777;
      expect(mode).toBe(0o600);
      // The backup still holds the original bytes (restorable).
      expect(await readFile(result.backupPath, 'utf8')).toBe(original);
    }
  });

  it('restores from a 0o600 backup when the write fails mid-operation', async () => {
    await mkdir(projectRoot, { recursive: true });
    const original = '# Project\n\noriginal body\n';
    await writeFile(claudeMdPath(projectRoot), original, 'utf8');
    const target: OptimizeTarget = { kind: 'claude-md', absPath: claudeMdPath(projectRoot) };

    const failing = new GatedApplier(fsWithFailingRename());
    await expect(
      failing.apply(candidate(target, '\n- appended\n'), { projectRoot, projectsDir }),
    ).rejects.toThrow(/boom on rename/);

    // Rollback restored the original byte-for-byte, no backup left behind.
    expect(await readFile(claudeMdPath(projectRoot), 'utf8')).toBe(original);
    const entries = await readdir(projectRoot);
    expect(entries.filter((e) => e.includes('abs-bak') || e.includes('abs-tmp'))).toEqual([]);
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
