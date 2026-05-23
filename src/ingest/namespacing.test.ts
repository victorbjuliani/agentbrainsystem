// src/ingest/namespacing.test.ts
import { describe, expect, it } from 'vitest';
import { harnessForPayload, isCodexTranscript, namespacedExternalId } from './namespacing.js';

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

describe('namespacedExternalId (W1)', () => {
  it('leaves Claude Code ids bare (migration-safe)', () => {
    expect(namespacedExternalId('claude-code', 'abc-123')).toBe('abc-123');
  });
  it('prefixes non-Claude harnesses', () => {
    expect(namespacedExternalId('codex', '019e2658')).toBe('codex:019e2658');
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
});
