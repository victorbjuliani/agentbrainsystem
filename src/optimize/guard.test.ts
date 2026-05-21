/**
 * Dedicated fail-closed `user|feedback` guard tests (issue #20).
 *
 * The single most important safety invariant in the optimize track: a candidate
 * that would touch an auto-memory entry whose frontmatter `metadata.type` is
 * `user` or `feedback` must be REFUSED — explicitly, with a refusal reason, NOT
 * silently skipped — and the file must be left byte-for-byte intact. Kept in its
 * own file (per the issue) so the guard's behaviour is unmistakable in the suite.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatedApplier } from './applier.js';
import { autoMemoryDir, autoMemoryEntryPath } from './targets.js';
import type { AutoMemoryType, OptimizeCandidate, OptimizeTarget } from './types.js';

let dir: string;
let projectRoot: string;
let projectsDir: string;
let applier: GatedApplier;

function entry(type: AutoMemoryType, body = 'existing body'): string {
  return `---\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
}

async function seedMemoryEntry(name: string, content: string): Promise<string> {
  const memDir = autoMemoryDir(projectRoot, projectsDir);
  await mkdir(memDir, { recursive: true });
  const absPath = autoMemoryEntryPath(projectRoot, projectsDir, name);
  await writeFile(absPath, content, 'utf8');
  return absPath;
}

function candidateFor(absPath: string): OptimizeCandidate {
  const target: OptimizeTarget = { kind: 'auto-memory', absPath };
  return {
    id: 'cand-1',
    target,
    title: 't',
    rationale: 'r',
    diff: '',
    proposedText: '\n- injected change\n',
    baseContent: '',
    evidenceIds: [1],
    priority: 'high',
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-guard-'));
  projectRoot = join(dir, 'project');
  projectsDir = join(dir, 'projects');
  applier = new GatedApplier();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fail-closed guard — user|feedback entries are REFUSED, not skipped', () => {
  it('REFUSES a user-type entry and leaves it intact', async () => {
    const content = entry('user');
    const absPath = await seedMemoryEntry('user-prefs.md', content);

    const result = await applier.apply(candidateFor(absPath), { projectRoot, projectsDir });

    expect(result.applied).toBe(false);
    expect(result.refused).toBe('protected-memory-type'); // explicit refusal
    expect(await readFile(absPath, 'utf8')).toBe(content); // byte-for-byte intact
  });

  it('REFUSES a feedback-type entry and leaves it intact', async () => {
    const content = entry('feedback');
    const absPath = await seedMemoryEntry('feedback.md', content);

    const result = await applier.apply(candidateFor(absPath), { projectRoot, projectsDir });

    expect(result.applied).toBe(false);
    expect(result.refused).toBe('protected-memory-type');
    expect(await readFile(absPath, 'utf8')).toBe(content);
  });
});

describe('fail-closed guard — non-protected entries still apply', () => {
  it('APPLIES to a project-type entry', async () => {
    const content = entry('project');
    const absPath = await seedMemoryEntry('project-notes.md', content);

    const result = await applier.apply(candidateFor(absPath), { projectRoot, projectsDir });

    expect(result.applied).toBe(true);
    expect(await readFile(absPath, 'utf8')).toBe(content + '\n- injected change\n');
  });

  it('APPLIES to a reference-type entry', async () => {
    const content = entry('reference');
    const absPath = await seedMemoryEntry('reference.md', content);
    const result = await applier.apply(candidateFor(absPath), { projectRoot, projectsDir });
    expect(result.applied).toBe(true);
  });

  it('APPLIES to a brand-new auto-memory entry (no protected type to honour)', async () => {
    // Target a file that does not exist yet — the guard reads no frontmatter.
    await mkdir(autoMemoryDir(projectRoot, projectsDir), { recursive: true });
    const absPath = autoMemoryEntryPath(projectRoot, projectsDir, 'fresh.md');
    const result = await applier.apply(candidateFor(absPath), { projectRoot, projectsDir });
    expect(result.applied).toBe(true);
  });
});
