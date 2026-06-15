import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  autoMemoryDir,
  autoMemoryEntryPath,
  claudeMdPath,
  consolidatedLessonsPointer,
  ensureIndexPointer,
  hasFrontmatter,
  indexHasConsolidatedPointer,
  isProtectedMemoryType,
  memoryIndexPath,
  parseFrontmatterType,
  projectSlug,
  resolveTarget,
} from './targets.js';
import type { OptimizeTarget } from './types.js';

// Use a POSIX-style absolute root so the slug is deterministic in tests.
const ROOT = '/tmp/abs-fake/Devs/agentbrainsystem';
const PROJECTS = '/tmp/abs-fake/.claude/projects';

describe('projectSlug', () => {
  it('replaces every path separator with a dash', () => {
    const slug = projectSlug(ROOT);
    // The leading separator becomes a leading dash (matching `-Users-…`).
    expect(slug).toBe(ROOT.split(sep).join('-'));
    expect(slug.startsWith('-')).toBe(true);
    expect(slug).not.toContain(sep);
  });

  it('resolves relative input and trailing slash to the same slug', () => {
    expect(projectSlug(`${ROOT}/`)).toBe(projectSlug(ROOT));
  });
});

describe('canonical paths', () => {
  it('claudeMdPath is <root>/CLAUDE.md', () => {
    expect(claudeMdPath(ROOT)).toBe(join(ROOT, 'CLAUDE.md'));
  });

  it('autoMemoryDir is <projects>/<slug>/memory', () => {
    expect(autoMemoryDir(ROOT, PROJECTS)).toBe(join(PROJECTS, projectSlug(ROOT), 'memory'));
  });

  it('autoMemoryEntryPath joins a named entry', () => {
    expect(autoMemoryEntryPath(ROOT, PROJECTS, 'x.md')).toBe(
      join(autoMemoryDir(ROOT, PROJECTS), 'x.md'),
    );
  });
});

describe('resolveTarget — allowlist', () => {
  it('accepts the canonical CLAUDE.md', () => {
    const t: OptimizeTarget = { kind: 'claude-md', absPath: claudeMdPath(ROOT) };
    expect(resolveTarget(t, ROOT, PROJECTS)?.absPath).toBe(claudeMdPath(ROOT));
  });

  it('accepts an auto-memory entry inside the memory dir', () => {
    const p = autoMemoryEntryPath(ROOT, PROJECTS, 'consolidated-lessons.md');
    const t: OptimizeTarget = { kind: 'auto-memory', absPath: p };
    expect(resolveTarget(t, ROOT, PROJECTS)?.absPath).toBe(p);
  });

  it('REJECTS a CLAUDE.md outside the project root', () => {
    const t: OptimizeTarget = { kind: 'claude-md', absPath: '/etc/CLAUDE.md' };
    expect(resolveTarget(t, ROOT, PROJECTS)).toBeNull();
  });

  it('REJECTS AGENTS.md masquerading as claude-md', () => {
    const t: OptimizeTarget = { kind: 'claude-md', absPath: join(ROOT, 'AGENTS.md') };
    expect(resolveTarget(t, ROOT, PROJECTS)).toBeNull();
  });

  it('REJECTS source code under the project root', () => {
    const t: OptimizeTarget = { kind: 'claude-md', absPath: join(ROOT, 'src/cli/cli.ts') };
    expect(resolveTarget(t, ROOT, PROJECTS)).toBeNull();
  });

  it('REJECTS an auto-memory path that escapes the memory dir via ..', () => {
    const escapePath = join(autoMemoryDir(ROOT, PROJECTS), '..', '..', 'evil.md');
    const t: OptimizeTarget = { kind: 'auto-memory', absPath: escapePath };
    expect(resolveTarget(t, ROOT, PROJECTS)).toBeNull();
  });

  it('REJECTS an auto-memory non-markdown file', () => {
    const t: OptimizeTarget = {
      kind: 'auto-memory',
      absPath: autoMemoryEntryPath(ROOT, PROJECTS, 'notes.txt'),
    };
    expect(resolveTarget(t, ROOT, PROJECTS)).toBeNull();
  });

  it('REJECTS a relative path', () => {
    const t = { kind: 'claude-md', absPath: 'CLAUDE.md' } as OptimizeTarget;
    expect(resolveTarget(t, ROOT, PROJECTS)).toBeNull();
  });
});

describe('parseFrontmatterType', () => {
  const fm = (type: string) => `---\nmetadata:\n  type: ${type}\n---\n\nbody\n`;

  it('reads a nested metadata.type', () => {
    expect(parseFrontmatterType(fm('user'))).toBe('user');
    expect(parseFrontmatterType(fm('feedback'))).toBe('feedback');
    expect(parseFrontmatterType(fm('project'))).toBe('project');
    expect(parseFrontmatterType(fm('reference'))).toBe('reference');
  });

  it('reads a top-level type', () => {
    expect(parseFrontmatterType('---\ntype: user\n---\nbody')).toBe('user');
  });

  it('returns undefined with no frontmatter', () => {
    expect(parseFrontmatterType('# just a heading\n\ntext')).toBeUndefined();
  });

  it('returns undefined for an unknown type', () => {
    expect(parseFrontmatterType(fm('weird'))).toBeUndefined();
  });

  it('returns undefined for unterminated frontmatter', () => {
    expect(parseFrontmatterType('---\nmetadata:\n  type: user\n')).toBeUndefined();
  });

  it('tolerates quotes and casing', () => {
    expect(parseFrontmatterType('---\nmetadata:\n  type: "USER"\n---')).toBe('user');
  });
});

describe('isProtectedMemoryType', () => {
  it('protects user and feedback', () => {
    expect(isProtectedMemoryType('user')).toBe(true);
    expect(isProtectedMemoryType('feedback')).toBe(true);
  });
  it('does not protect project/reference/undefined', () => {
    expect(isProtectedMemoryType('project')).toBe(false);
    expect(isProtectedMemoryType('reference')).toBe(false);
    expect(isProtectedMemoryType(undefined)).toBe(false);
  });
});

describe('memoryIndexPath (#140)', () => {
  it('is MEMORY.md inside the project auto-memory dir', () => {
    expect(memoryIndexPath(ROOT, PROJECTS)).toBe(join(autoMemoryDir(ROOT, PROJECTS), 'MEMORY.md'));
  });
});

describe('hasFrontmatter (#140)', () => {
  it('detects a leading frontmatter block (with closing fence)', () => {
    expect(hasFrontmatter('---\nname: x\nmetadata:\n  type: project\n---\n## H\n')).toBe(true);
  });
  it('tolerates a leading BOM', () => {
    expect(hasFrontmatter('﻿---\nname: x\n---\nbody')).toBe(true);
  });
  it('is false for a frontmatter-less file (legacy dead-drop)', () => {
    expect(hasFrontmatter('## Consolidated Memory (managed by abs optimize)\n- a\n')).toBe(false);
  });
  it('is false for an unterminated frontmatter', () => {
    expect(hasFrontmatter('---\nname: x\nno closing fence\n')).toBe(false);
  });
  it('is false for an empty string', () => {
    expect(hasFrontmatter('')).toBe(false);
  });
  it('is false for a bare "---" with no newline/body (not a frontmatter block)', () => {
    expect(hasFrontmatter('---')).toBe(false);
  });
  it('detects CRLF frontmatter (Windows-written entry)', () => {
    expect(hasFrontmatter('---\r\nname: x\r\nmetadata:\r\n  type: project\r\n---\r\nbody')).toBe(
      true,
    );
  });
});

describe('ensureIndexPointer (#140)', () => {
  it('creates a Memory Index with the pointer when content is empty', () => {
    const { content, changed } = ensureIndexPointer('');
    expect(changed).toBe(true);
    expect(content).toContain('# Memory Index');
    expect(content).toContain('](consolidated-lessons.md)');
  });

  it('appends the pointer additively, leaving existing user lines intact', () => {
    const existing = '# Memory Index\n\n- [User note](user-note.md) — something the user wrote\n';
    const { content, changed } = ensureIndexPointer(existing);
    expect(changed).toBe(true);
    expect(content.startsWith(existing.replace(/\s+$/, ''))).toBe(true); // user line preserved verbatim
    expect(content).toContain('](consolidated-lessons.md)');
  });

  it('is idempotent when the pointer already exists (link-target match)', () => {
    const existing = `# Memory Index\n\n${consolidatedLessonsPointer()}\n`;
    const { content, changed } = ensureIndexPointer(existing);
    expect(changed).toBe(false);
    expect(content).toBe(existing);
  });

  it('does NOT treat a prose mention of the filename as the pointer', () => {
    const prose = '# Memory Index\n\n- [Note](n.md) — see consolidated-lessons.md for details\n';
    expect(indexHasConsolidatedPointer(prose)).toBe(false);
    expect(ensureIndexPointer(prose).changed).toBe(true);
  });

  it('handles a missing trailing newline cleanly (single separating newline + final newline)', () => {
    const { content } = ensureIndexPointer('# Memory Index\n\n- [A](a.md) — x');
    expect(content).toBe(`# Memory Index\n\n- [A](a.md) — x\n${consolidatedLessonsPointer()}\n`);
  });
});
