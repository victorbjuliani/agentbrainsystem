import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGeminiChat } from './gemini-chat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(__dirname, '__fixtures__', name);
const SAMPLE_PATH = '/h/.gemini/tmp/p/chats/session-2026-05-23T04-24-78432a44.json';

describe('parseGeminiChat (#68)', () => {
  it('extracts user + assistant prose + message ids from a real Gemini chat file', () => {
    const raw = readFileSync(fixture('gemini-session.json'), 'utf8');
    const e = parseGeminiChat(raw, SAMPLE_PATH);
    expect(e.map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(e[0]).toMatchObject({
      sessionId: '78432a44-385f-41f6-8a71-646d51996f8a',
      text: 'say hi',
      id: '93a3561e-ace3-46b8-82e8-d24cecd6c0e9',
    });
    expect(e[1]?.text).toBe('hi!');
    expect(e[1]?.id).toBeTruthy(); // id-watermark anchor present (W-NEW-1)
    expect(e.every((x) => x.cwd === undefined)).toBe(true); // C-NEW-1: parser emits NO cwd
  });

  it('sets turnKey = the per-message id for prose←edit anchor parity (#108)', () => {
    const raw = readFileSync(fixture('gemini-session.json'), 'utf8');
    const e = parseGeminiChat(raw, SAMPLE_PATH);
    // Every entry's turnKey mirrors its id so #99's propagation activates the moment
    // Gemini gains tool-anchor extraction — turn-scoped, never session-wide.
    expect(e.length).toBeGreaterThan(0);
    expect(e.every((x) => x.turnKey === x.id)).toBe(true);
  });

  it('skips info/error chrome and malformed JSON', () => {
    expect(parseGeminiChat('not json', '/p/chats/session-x.json')).toEqual([]);
    const doc = JSON.stringify({
      sessionId: 's',
      messages: [
        { id: 'i1', type: 'info', content: 'startup' },
        { id: 'e1', type: 'error', content: 'boom' },
        { id: 'w1', type: 'warning', content: 'careful' },
        { id: 'u1', type: 'user', content: [{ text: 'real' }] },
      ],
    });
    const e = parseGeminiChat(doc, SAMPLE_PATH);
    expect(e.map((x) => x.role)).toEqual(['user']);
    expect(e[0]?.text).toBe('real');
  });

  it('accepts a plain-string content and flattens Part[] text', () => {
    const doc = JSON.stringify({
      sessionId: 's',
      messages: [
        { id: 'u1', type: 'user', content: 'plain string' },
        {
          id: 'g1',
          type: 'gemini',
          content: [{ text: 'a' }, { functionCall: { name: 'x' } }, { text: 'b' }],
        },
      ],
    });
    const e = parseGeminiChat(doc, SAMPLE_PATH);
    expect(e[0]?.text).toBe('plain string');
    expect(e[1]?.text).toBe('a\n\nb'); // functionCall part ignored (prose-only)
  });
});
