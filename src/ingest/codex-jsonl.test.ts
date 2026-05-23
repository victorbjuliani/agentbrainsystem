// src/ingest/codex-jsonl.test.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codexParseTranscript } from './codex-jsonl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, '__fixtures__/codex/rollout-sample.jsonl'), 'utf8');

const REAL_PATH = '/abs/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl';
const CWD = '/Users/vbjuliani/Meu Mac/Profissional/PG_Consultoria/AI_Team/PGIntegra';

describe('codexParseTranscript', () => {
  it('takes sessionId from the FILENAME and cwd from session_meta, applied to every entry', () => {
    const { entries, cwd } = codexParseTranscript(fixture, REAL_PATH);
    expect(entries.length).toBeGreaterThan(0);
    expect(cwd).toBe(CWD); // returned for the kv_meta cache
    for (const e of entries) {
      expect(e.sessionId).toBe('019e2658-c8b0-7230-9b59-c3646fbf0c7b'); // FROM FILENAME (W4)
      expect(e.cwd).toBe(CWD);
    }
  });

  it('extracts user prose from response_item input_text and assistant prose from output_text', () => {
    const { entries } = codexParseTranscript(fixture, REAL_PATH);
    const user = entries.find((e) => e.role === 'user');
    const assistant = entries.find((e) => e.role === 'assistant');
    expect(user?.text).toContain('Inicie o serviço local');
    expect(assistant?.text).toContain('localizar');
  });

  it('skips event_msg mirrors, turn_context, function_call, developer, and session_meta', () => {
    const { entries } = codexParseTranscript(fixture, REAL_PATH);
    const roles = entries.map((e) => e.role).sort();
    expect(roles.every((r) => r === 'user' || r === 'assistant')).toBe(true);
    // The developer turn (AGENTS.md echo) is dropped.
    expect(entries.some((e) => e.text.includes('AGENTS.md instructions'))).toBe(false);
  });

  it('multi-turn: every twinned turn captured ONCE AND an event_msg-only turn is NOT dropped (W-NEW-4)', () => {
    const multi = readFileSync(
      join(__dirname, '__fixtures__/codex/rollout-multiturn.jsonl'),
      'utf8',
    );
    const { entries } = codexParseTranscript(multi, REAL_PATH);
    // (a) No double-count: each distinct turn text appears exactly once.
    const texts = entries.map((e) => e.text.replace(/\s+/g, ' ').trim().toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
    // (b) Every distinct user + assistant turn is represented (>=3 turns).
    expect(entries.filter((e) => e.role === 'user').length).toBeGreaterThanOrEqual(2);
    expect(entries.filter((e) => e.role === 'assistant').length).toBeGreaterThanOrEqual(1);
    // (c) The event_msg-ONLY turn (no response_item/message twin) is still captured.
    expect(texts.some((t) => t.includes('no response_item twin'))).toBe(true);
  });

  it('groups by FILENAME UUID even on a header-less slice; uses cwdHint for project (W4 resume)', () => {
    const noMeta = fixture
      .split('\n')
      .filter((l) => !l.includes('"session_meta"'))
      .join('\n');
    const { entries, cwd } = codexParseTranscript(noMeta, REAL_PATH, '/cached/cwd');
    expect(entries[0]?.sessionId).toBe('019e2658-c8b0-7230-9b59-c3646fbf0c7b');
    expect(entries[0]?.cwd).toBe('/cached/cwd');
    expect(cwd).toBeUndefined(); // no header in this slice
  });

  it('extracts the UUID from REAL rollout filenames (N5 regex regression)', () => {
    const noMeta =
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}\n';
    for (const [path, want] of [
      [
        '/s/rollout-2026-04-21T13-22-02-019db0d9-471b-7ce0-aa8c-d9e3485a8be1.jsonl',
        '019db0d9-471b-7ce0-aa8c-d9e3485a8be1',
      ],
      [
        '/s/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl',
        '019e2658-c8b0-7230-9b59-c3646fbf0c7b',
      ],
    ] as const) {
      expect(codexParseTranscript(noMeta, path).entries[0]?.sessionId).toBe(want);
    }
  });

  it('strips the AGENTS.md instructions preamble + <INSTRUCTIONS> wrapper from a user turn (N1)', () => {
    // Real Codex rollouts inject the project AGENTS.md into the FIRST user turn as
    // a `# AGENTS.md instructions for …` preamble + an <INSTRUCTIONS>…</INSTRUCTIONS>
    // block. Boilerplate-only → dropped (no observation); real prose underneath survives.
    const boilerplateOnly = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '# AGENTS.md instructions for /work/proj\n\n<INSTRUCTIONS>\nAlways run npm run check.\nNever git add -A.\n</INSTRUCTIONS>',
          },
        ],
      },
    });
    const dropped = codexParseTranscript(`${boilerplateOnly}\n`, REAL_PATH).entries;
    expect(dropped).toHaveLength(0); // pure boilerplate → no stored observation

    const withProse = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '# AGENTS.md instructions for /work/proj\n\n<INSTRUCTIONS>\nAlways run npm run check.\n</INSTRUCTIONS>\n\nInicie o serviço local do PGIntegra.',
          },
        ],
      },
    });
    const kept = codexParseTranscript(`${withProse}\n`, REAL_PATH).entries;
    expect(kept).toHaveLength(1);
    expect(kept[0]?.text).toBe('Inicie o serviço local do PGIntegra.');
    expect(kept[0]?.text).not.toContain('AGENTS.md instructions');
    expect(kept[0]?.text).not.toContain('INSTRUCTIONS');
    expect(kept[0]?.text).not.toContain('npm run check');
  });

  it('does NOT strip legitimate user prose that merely mentions instructions (N1 safety)', () => {
    const prose = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Update the AGENTS.md instructions so the build step runs first.',
          },
        ],
      },
    });
    const entries = codexParseTranscript(`${prose}\n`, REAL_PATH).entries;
    expect(entries).toHaveLength(1);
    // Inline mention (not a leading `# AGENTS.md instructions for …` header) survives.
    expect(entries[0]?.text).toBe(
      'Update the AGENTS.md instructions so the build step runs first.',
    );
  });

  it('never throws on malformed lines — a bad line is a skip', () => {
    expect(() =>
      codexParseTranscript('not json\n{"type":"response_item"}\n', REAL_PATH),
    ).not.toThrow();
  });
});
