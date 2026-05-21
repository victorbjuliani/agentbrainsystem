import { describe, expect, it } from 'vitest';
import type { RecallHit } from '../recall/index.js';
import type { Observation } from '../store/index.js';
import { CHAR_BUDGET, handleUserPromptSubmit, renderRecallBlock } from './user-prompt-submit.js';

function hit(id: number, kind: string, content: string): RecallHit {
  const observation: Observation = {
    id,
    sessionId: 1,
    kind,
    content,
    createdAt: '2026-05-20T00:00:00.000Z',
  };
  return { observation, score: -id, ftsRank: id };
}

describe('renderRecallBlock — bounding', () => {
  it('renders hits with kind tags under a header', () => {
    const block = renderRecallBlock([
      hit(1, 'lesson', 'Prefer FTS-only recall on the per-prompt hook path.'),
      hit(2, 'note', 'SQLite WAL keeps writes durable across restarts.'),
    ]);
    expect(block).toContain('Relevant memory');
    expect(block).toContain('[lesson] Prefer FTS-only recall');
    expect(block).toContain('[note] SQLite WAL');
  });

  it('dedupes by normalized content', () => {
    const block = renderRecallBlock([
      hit(1, 'note', 'Use git rebase to squash commits.'),
      hit(2, 'note', 'use   git rebase   to squash commits.  '),
    ]);
    expect(block.match(/git rebase/g)?.length).toBe(1);
  });

  it('drops too-thin hits and returns empty when nothing survives', () => {
    expect(renderRecallBlock([hit(1, 'note', 'short')])).toBe('');
    expect(renderRecallBlock([])).toBe('');
  });

  it('truncates to the char budget', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      hit(i + 1, 'note', `distinct observation number ${i} with enough length to count here`),
    );
    const block = renderRecallBlock(many);
    // Header + lines, kept within a small multiple of the budget.
    expect(block.length).toBeLessThanOrEqual(CHAR_BUDGET + 80);
  });
});

describe('handleUserPromptSubmit', () => {
  it('injects recalled memory in the UserPromptSubmit envelope', async () => {
    const line = await handleUserPromptSubmit(
      { prompt: 'how do I squash commits?' },
      { recall: async () => [hit(1, 'lesson', 'Use git rebase --interactive to squash commits.')] },
    );
    const parsed = JSON.parse(line as string);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('git rebase');
  });

  it('returns undefined when there is no prompt', async () => {
    const calls: string[] = [];
    const line = await handleUserPromptSubmit(
      {},
      {
        recall: async (p) => {
          calls.push(p);
          return [];
        },
      },
    );
    expect(line).toBeUndefined();
    expect(calls).toEqual([]); // no recall attempted without a prompt
  });

  it('returns undefined when recall finds nothing', async () => {
    const line = await handleUserPromptSubmit(
      { prompt: 'unmatched query' },
      { recall: async () => [] },
    );
    expect(line).toBeUndefined();
  });
});
