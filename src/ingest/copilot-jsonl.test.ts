// src/ingest/copilot-jsonl.test.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCopilotLineParser } from './copilot-jsonl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, '__fixtures__/copilot-events.jsonl'), 'utf8');

const UUID = '3db5c133-d9b9-419c-a649-d8d1b0514c49';
const REAL_PATH = `/Users/me/.copilot/session-state/${UUID}/events.jsonl`;
const CWD = '/Users/me/Devs/agentbrainsystem';

function parseAll(text: string, path = REAL_PATH, cwdHint?: string) {
  const parser = createCopilotLineParser(path, cwdHint);
  const entries = text
    .split('\n')
    .map((l) => parser.pushLine(l))
    .filter((e): e is NonNullable<typeof e> => e !== undefined);
  return { entries, observedCwd: parser.observedCwd() };
}

describe('createCopilotLineParser (#69)', () => {
  it('derives sessionId from the session-state dir UUID, applied to every entry', () => {
    const { entries } = parseAll(fixture);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.sessionId).toBe(UUID);
  });

  it('records cwd from session.context_changed and returns it via observedCwd()', () => {
    const { entries, observedCwd } = parseAll(fixture);
    expect(observedCwd).toBe(CWD);
    for (const e of entries) expect(e.cwd).toBe(CWD);
  });

  it('parses a user.message into a user entry with text + id + timestamp', () => {
    const { entries } = parseAll(fixture);
    const user = entries.find((e) => e.role === 'user');
    expect(user?.text).toBe('Add a byte cursor to the copilot parser');
    expect(user?.id).toBe('evt-003');
    expect(user?.timestamp).toBe('2026-05-23T10:00:02.000Z');
  });

  it('parses an assistant.message into an assistant entry', () => {
    const { entries } = parseAll(fixture);
    const asst = entries.find((e) => e.role === 'assistant');
    expect(asst?.text).toContain('localize the cursor logic');
  });

  it('skips streaming *_delta lines, only finalized *.message turns are kept', () => {
    const { entries } = parseAll(fixture);
    expect(entries.some((e) => e.text === 'Sure, ')).toBe(false);
  });

  it('dedupes a repeated event id (second push returns undefined)', () => {
    const parser = createCopilotLineParser(REAL_PATH, CWD);
    const line = JSON.stringify({
      id: 'dup-1',
      timestamp: 't',
      type: 'user.message',
      data: { content: 'hello' },
    });
    expect(parser.pushLine(line)).toBeDefined();
    expect(parser.pushLine(line)).toBeUndefined();
  });

  it('skips an empty-content message with no anchors', () => {
    const { entries } = parseAll(fixture);
    expect(entries.some((e) => e.text === '' && e.toolAnchors.length === 0)).toBe(false);
  });

  it('mines a best-effort Write anchor from assistant.message toolRequests', () => {
    const { entries } = parseAll(fixture);
    const asst = entries.find((e) => e.role === 'assistant');
    expect(asst?.toolAnchors.some((a) => a.tool === 'Write')).toBe(true);
    expect(
      asst?.toolAnchors.some((a) => a.filePath.endsWith('src/ingest/copilot-jsonl.ts')),
    ).toBe(true);
  });

  it('degrades to no anchors when toolRequests shape is unrecognized', () => {
    const parser = createCopilotLineParser(REAL_PATH, CWD);
    const line = JSON.stringify({
      id: 'x1',
      timestamp: 't',
      type: 'assistant.message',
      data: { content: 'done', toolRequests: 'not-an-array' },
    });
    const e = parser.pushLine(line);
    expect(e?.toolAnchors).toEqual([]);
  });

  it('falls back to cwdHint on a header-less slice', () => {
    const noCtx = fixture
      .split('\n')
      .filter((l) => !l.includes('session.context_changed'))
      .join('\n');
    const { entries, observedCwd } = parseAll(noCtx, REAL_PATH, '/cached/cwd');
    expect(entries[0]?.cwd).toBe('/cached/cwd');
    expect(observedCwd).toBeUndefined();
  });

  it('never throws on malformed/blank lines', () => {
    const parser = createCopilotLineParser(REAL_PATH);
    expect(() => parser.pushLine('not json')).not.toThrow();
    expect(parser.pushLine('')).toBeUndefined();
    expect(parser.pushLine('not json')).toBeUndefined();
  });
});
