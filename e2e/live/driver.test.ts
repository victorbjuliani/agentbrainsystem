import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseStream, type StreamEvents } from './driver.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '__fixtures__/session-b.stream.jsonl');

describe('parseStream', () => {
  it('extracts the UserPromptSubmit injection and the assistant answer from a real stream', () => {
    const ev: StreamEvents = parseStream(readFileSync(FIXTURE, 'utf8'));
    expect(ev.promptSubmitInjection).toBeDefined();
    expect(ev.promptSubmitInjection).toContain('<recalled-memory>');
    expect(ev.assistantText.length).toBeGreaterThan(0);
    expect(ev.hookEvents).toContain('UserPromptSubmit');
  });

  it('prefers the fenced injection when several UserPromptSubmit hooks fire', () => {
    const raw = [
      JSON.stringify({
        type: 'system',
        subtype: 'hook_response',
        hook_event: 'UserPromptSubmit',
        output: JSON.stringify({ hookSpecificOutput: { additionalContext: 'unrelated hook' } }),
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'hook_response',
        hook_event: 'UserPromptSubmit',
        output: JSON.stringify({
          hookSpecificOutput: {
            additionalContext: 'x <recalled-memory>\n- cents\n</recalled-memory>',
          },
        }),
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'hook_response',
        hook_event: 'UserPromptSubmit',
        output: JSON.stringify({ hookSpecificOutput: { additionalContext: 'another unrelated' } }),
      }),
    ].join('\n');
    const ev = parseStream(raw);
    expect(ev.promptSubmitInjection).toContain('<recalled-memory>');
  });

  it('tolerates blank/garbage lines without throwing', () => {
    const ev = parseStream('\n{not json}\n{"type":"result","subtype":"success","result":"ok"}\n');
    expect(ev.resultText).toBe('ok');
  });
});
