import { describe, expect, it } from 'vitest';
import { parseLine } from './claude-jsonl.js';

/** Build a JSONL user-turn line with the given string content. */
function userLine(content: unknown): string {
  return JSON.stringify({ type: 'user', sessionId: 's1', message: { role: 'user', content } });
}

/**
 * #36: harness-injected wrappers must not be stored as the user's prose. We strip
 * the well-delimited ones (system-reminder, slash-command and local-command echo)
 * while preserving the human's actual text. Skill-injection blocks ("Base
 * directory for this skill: …") have no machine-readable boundary and are handled
 * separately — this suite asserts they are left untouched for now.
 */
describe('parseLine — strips injected wrappers from user turns (#36)', () => {
  it('strips a <system-reminder> block but keeps the real prompt around it', () => {
    const entry = parseLine(
      userLine(
        'Fix the ingest race.\n\n<system-reminder>You have superpowers. Use skills.</system-reminder>',
      ),
    );
    expect(entry?.text).toBe('Fix the ingest race.');
  });

  it('strips a multi-line <system-reminder> block', () => {
    const entry = parseLine(
      userLine('real ask\n<system-reminder>\nline one\nline two\n</system-reminder>\nmore ask'),
    );
    expect(entry?.text).toBe('real ask\n\nmore ask');
  });

  it('drops a turn that is only slash-command wrappers', () => {
    const line = userLine(
      '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
    );
    // nothing human-authored remains → the turn is skipped entirely
    expect(parseLine(line)).toBeNull();
  });

  it('strips local-command stdout and caveat wrappers', () => {
    const line = userLine(
      '<local-command-caveat>Caveat: generated while running local commands.</local-command-caveat>\n<local-command-stdout>Compacted (ctrl+o)</local-command-stdout>',
    );
    expect(parseLine(line)).toBeNull();
  });

  it('keeps the real prompt when wrappers are mixed in', () => {
    const entry = parseLine(userLine('<command-name>/foo</command-name>\nactually do the thing'));
    expect(entry?.text).toBe('actually do the thing');
  });

  it('leaves a plain user prompt unchanged', () => {
    const entry = parseLine(userLine('just a normal question about the code'));
    expect(entry?.text).toBe('just a normal question about the code');
  });

  it('keeps a non-meta turn that merely starts with skill-like text', () => {
    // Without the isMeta flag this is just prose — wrapper-stripping must not touch it.
    const skill = 'Base directory for this skill: /Users/x/.claude/skills/foo\n\n# Foo\n\nbody...';
    const entry = parseLine(userLine(skill));
    expect(entry?.text).toBe(skill);
  });
});

/** Build a JSONL line with an explicit isMeta flag (string content). */
function metaLine(content: string, isMeta: boolean, type = 'user'): string {
  return JSON.stringify({
    type,
    isMeta,
    sessionId: 's1',
    message: { role: type, content },
  });
}

/**
 * #38: Claude Code marks harness-injected turns (skill bodies, hook
 * notifications, other system context) with top-level `isMeta: true`. These are
 * not the human's conversation — they inflate the store and pollute recall — so
 * parseLine drops them. The user's real intent survives in the non-meta turns.
 */
describe('parseLine — drops isMeta (harness-injected) turns (#38)', () => {
  it('drops a skill-injection turn flagged isMeta', () => {
    const skill = `Base directory for this skill: /Users/x/.claude/skills/foo\n\n# Foo\n\n${'body '.repeat(2000)}`;
    expect(parseLine(metaLine(skill, true))).toBeNull();
  });

  it('drops an isMeta hook-notification turn', () => {
    expect(parseLine(metaLine('A session-scoped Stop hook is now active…', true))).toBeNull();
  });

  it('keeps a real prompt when isMeta is false', () => {
    const entry = parseLine(metaLine('does the PO flow already work?', false));
    expect(entry?.text).toBe('does the PO flow already work?');
  });

  it('keeps a real prompt when isMeta is absent', () => {
    const entry = parseLine(userLine('continue'));
    expect(entry?.text).toBe('continue');
  });

  it('drops an isMeta assistant turn too', () => {
    expect(parseLine(metaLine('injected system context', true, 'assistant'))).toBeNull();
  });
});
