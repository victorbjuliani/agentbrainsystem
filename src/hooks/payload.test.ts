import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildContextOutput, parseHookPayload, readStdin } from './payload.js';

describe('parseHookPayload', () => {
  it('extracts the known fields from a well-formed payload', () => {
    const raw = JSON.stringify({
      session_id: 'abc',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/repo',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'how do I add a hook?',
      source: 'startup',
    });
    expect(parseHookPayload(raw)).toEqual({
      sessionId: 'abc',
      transcriptPath: '/tmp/t.jsonl',
      cwd: '/repo',
      hookEventName: 'UserPromptSubmit',
      prompt: 'how do I add a hook?',
      source: 'startup',
    });
  });

  it('returns an empty payload on malformed JSON (never throws)', () => {
    expect(parseHookPayload('not json {{{')).toEqual({});
    expect(parseHookPayload('')).toEqual({});
    expect(parseHookPayload('null')).toEqual({});
    expect(parseHookPayload('[1,2,3]')).toEqual({});
  });

  it('drops empty-string and wrong-typed fields', () => {
    const raw = JSON.stringify({ session_id: '', prompt: 42, cwd: '/here' });
    expect(parseHookPayload(raw)).toEqual({ cwd: '/here' });
  });
});

describe('buildContextOutput', () => {
  it('wraps text in the documented hookSpecificOutput envelope', () => {
    const line = buildContextOutput('SessionStart', 'baseline block');
    expect(line).not.toBeNull();
    expect(JSON.parse(line as string)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'baseline block' },
    });
  });

  it('returns null for empty/whitespace text', () => {
    expect(buildContextOutput('UserPromptSubmit', '')).toBeNull();
    expect(buildContextOutput('UserPromptSubmit', '   \n ')).toBeNull();
  });
});

describe('readStdin', () => {
  it('reads the whole stream as utf8', async () => {
    const stream = Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]);
    expect(await readStdin(stream)).toBe('{"a":1}');
  });

  it('resolves empty string on an empty stream', async () => {
    expect(await readStdin(Readable.from([]))).toBe('');
  });
});
