// src/ingest/namespacing.test.ts
import { describe, expect, it } from 'vitest';
import {
  harnessForPayload,
  isCodexTranscript,
  isCopilotTranscript,
  isGeminiTranscript,
  namespacedExternalId,
} from './namespacing.js';

const COPILOT_PATH =
  '/Users/x/.copilot/session-state/3db5c133-d9b9-419c-a649-d8d1b0514c49/events.jsonl';

describe('isCodexTranscript (W-R3-1 — leaf classifier)', () => {
  it('matches a codex sessions dir and a rollout filename', () => {
    expect(
      isCodexTranscript(
        '/u/.codex/sessions/2026/05/14/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl',
      ),
    ).toBe(true);
  });
  it('rejects a Claude projects path', () => {
    expect(isCodexTranscript('/u/.claude/projects/-x/sess.jsonl')).toBe(false);
  });
  it('matches a Windows backslash-separated codex path (#86)', () => {
    expect(
      isCodexTranscript(
        'C:\\Users\\dev\\.codex\\sessions\\2026\\05\\14\\rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl',
      ),
    ).toBe(true);
  });
});

describe('isGeminiTranscript (#68 — leaf classifier)', () => {
  it('detects a Gemini chats transcript path', () => {
    expect(
      isGeminiTranscript(
        '/Users/x/.gemini/tmp/myproj/chats/session-2026-05-23T04-24-78432a44.json',
      ),
    ).toBe(true);
  });
  it('rejects a Codex rollout path', () => {
    expect(
      isGeminiTranscript(
        '/Users/x/.codex/sessions/2026/05/23/rollout-2026-05-23T04-24-00-78432a44-385f-41f6-8a71-646d51996f8a.jsonl',
      ),
    ).toBe(false);
  });
  it('rejects a Claude projects path', () => {
    expect(isGeminiTranscript('/Users/x/.claude/projects/p/abc.jsonl')).toBe(false);
  });
  it('detects a relocated Gemini home (no ~/.gemini/tmp/ prefix) by shape alone (#90b)', () => {
    expect(
      isGeminiTranscript(
        '/srv/xdg-config/gemini/myproj/chats/session-2026-05-23T04-24-78432a44.json',
      ),
    ).toBe(true);
  });
  it('detects a Windows backslash-separated Gemini path (#86)', () => {
    expect(
      isGeminiTranscript(
        'C:\\Users\\dev\\.gemini\\tmp\\p\\chats\\session-2026-05-23T04-24-78432a44.json',
      ),
    ).toBe(true);
  });
});

describe('isCopilotTranscript (#69 — leaf classifier)', () => {
  it('detects a Copilot events.jsonl session-state path', () => {
    expect(isCopilotTranscript(COPILOT_PATH)).toBe(true);
  });
  it('rejects a Codex rollout path', () => {
    expect(
      isCopilotTranscript(
        '/Users/x/.codex/sessions/2026/05/23/rollout-2026-05-23T04-24-00-78432a44-385f-41f6-8a71-646d51996f8a.jsonl',
      ),
    ).toBe(false);
  });
  it('rejects a Gemini chats path', () => {
    expect(
      isCopilotTranscript('/Users/x/.gemini/tmp/p/chats/session-2026-05-23T04-24-78432a44.json'),
    ).toBe(false);
  });
  it('rejects a Claude projects path', () => {
    expect(isCopilotTranscript('/Users/x/.claude/projects/p/abc.jsonl')).toBe(false);
  });
  it('rejects a session-state dir whose UUID is malformed', () => {
    expect(isCopilotTranscript('/Users/x/.copilot/session-state/not-a-uuid/events.jsonl')).toBe(
      false,
    );
  });
});

describe('isCopilotTranscript (#69 — leaf classifier)', () => {
  it('detects a Copilot events.jsonl session-state path', () => {
    expect(isCopilotTranscript(COPILOT_PATH)).toBe(true);
  });
  it('rejects a Codex rollout path', () => {
    expect(
      isCopilotTranscript(
        '/Users/x/.codex/sessions/2026/05/23/rollout-2026-05-23T04-24-00-78432a44-385f-41f6-8a71-646d51996f8a.jsonl',
      ),
    ).toBe(false);
  });
  it('rejects a Gemini chats path', () => {
    expect(
      isCopilotTranscript('/Users/x/.gemini/tmp/p/chats/session-2026-05-23T04-24-78432a44.json'),
    ).toBe(false);
  });
  it('rejects a Claude projects path', () => {
    expect(isCopilotTranscript('/Users/x/.claude/projects/p/abc.jsonl')).toBe(false);
  });
  it('rejects a session-state dir whose UUID is malformed', () => {
    expect(isCopilotTranscript('/Users/x/.copilot/session-state/not-a-uuid/events.jsonl')).toBe(
      false,
    );
  });
});

describe('namespacedExternalId (W1)', () => {
  it('leaves Claude Code ids bare (migration-safe)', () => {
    expect(namespacedExternalId('claude-code', 'abc-123')).toBe('abc-123');
  });
  it('prefixes non-Claude harnesses', () => {
    expect(namespacedExternalId('codex', '019e2658')).toBe('codex:019e2658');
  });
  it('namespaces a gemini session id with the gemini: prefix', () => {
    expect(namespacedExternalId('gemini', 'u-1')).toBe('gemini:u-1');
  });
  it('keeps Claude bare and Codex codex: unchanged (migration-safe)', () => {
    expect(namespacedExternalId('claude-code', 'c-1')).toBe('c-1');
    expect(namespacedExternalId('codex', 'x-1')).toBe('codex:x-1');
  });
});

describe('harnessForPayload (C-NEW-1)', () => {
  it('classifies a Codex rollout path as codex', () => {
    expect(
      harnessForPayload({
        transcriptPath:
          '/u/.codex/sessions/2026/05/14/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl',
      }),
    ).toBe('codex');
  });
  it('classifies a Claude projects path as claude-code (bare)', () => {
    expect(harnessForPayload({ transcriptPath: '/u/.claude/projects/-x/sess.jsonl' })).toBe(
      'claude-code',
    );
  });
  it('defaults to claude-code when no transcript path is present', () => {
    expect(harnessForPayload({})).toBe('claude-code');
  });
  it('routes a Gemini chats path to gemini (#68)', () => {
    expect(
      harnessForPayload({
        transcriptPath: '/h/.gemini/tmp/p/chats/session-2026-05-23T04-24-78432a44.json',
      }),
    ).toBe('gemini');
  });
  it('routes a Copilot events.jsonl path to copilot (#69)', () => {
    expect(harnessForPayload({ transcriptPath: COPILOT_PATH })).toBe('copilot');
  });
});
