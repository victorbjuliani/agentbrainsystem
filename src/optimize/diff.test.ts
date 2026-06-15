import { describe, expect, it } from 'vitest';
import { renderAppendDiff, renderFullDiff, splitLines } from './diff.js';

describe('splitLines', () => {
  it('returns no lines for empty string', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('drops the trailing empty from a final newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('keeps internal blank lines', () => {
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
  });

  it('normalises CRLF', () => {
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
  });
});

describe('renderAppendDiff', () => {
  it('returns empty string for an empty append', () => {
    expect(renderAppendDiff('CLAUDE.md', 'hello\n', '')).toBe('');
  });

  it('renders headers, a hunk, context, and + lines', () => {
    const diff = renderAppendDiff('CLAUDE.md', 'line1\nline2\n', '\nadded\n');
    expect(diff).toContain('--- a/CLAUDE.md');
    expect(diff).toContain('+++ b/CLAUDE.md');
    expect(diff).toContain('@@ -');
    expect(diff).toContain(' line2'); // context
    expect(diff).toContain('+added'); // addition
  });

  it('uses the empty-file old form when the original is empty', () => {
    const diff = renderAppendDiff('CLAUDE.md', '', 'new line\n');
    expect(diff).toContain('@@ -0,0 +');
    expect(diff).toContain('+new line');
  });

  it('limits context to the trailing lines', () => {
    const original = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
    const diff = renderAppendDiff('f.md', original, 'x\n');
    // Only the last 3 context lines appear.
    expect(diff).toContain(' l9');
    expect(diff).toContain(' l8');
    expect(diff).toContain(' l7');
    expect(diff).not.toContain(' l6');
  });
});

describe('renderFullDiff (#140)', () => {
  it('returns empty string when content is unchanged', () => {
    expect(renderFullDiff('m.md', 'same\n', 'same\n')).toBe('');
  });

  it('degrades to the append form for an empty original', () => {
    const diff = renderFullDiff('m.md', '', 'frontmatter\nbody\n');
    expect(diff).toContain('@@ -0,0 +');
    expect(diff).toContain('+frontmatter');
    expect(diff).toContain('+body');
  });

  it('renders the old side as removals and the new side as additions (front edit)', () => {
    // Prepending frontmatter — an append-only diff cannot express this.
    const diff = renderFullDiff('m.md', '## Header\n- a\n', '---\nname: x\n---\n## Header\n- a\n');
    expect(diff).toContain('--- a/m.md');
    expect(diff).toContain('+++ b/m.md');
    expect(diff).toContain('-## Header');
    expect(diff).toContain('+name: x');
    expect(diff).toContain('+## Header');
  });
});
