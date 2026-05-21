import { describe, expect, it } from 'vitest';
import { handleSessionStart, renderBaseline } from './session-start.js';

describe('renderBaseline', () => {
  it('emits no block for an empty store', () => {
    expect(renderBaseline({ sessions: 0, observations: 0, pending: 0, flagged: false })).toBe('');
  });

  it('reports stats without a staleness line when not flagged', () => {
    const block = renderBaseline({ sessions: 2, observations: 40, pending: 3, flagged: false });
    expect(block).toContain('40 observation(s) across 2 session(s)');
    expect(block).not.toContain('Staleness');
  });

  it('adds the pending-optimization line when flagged', () => {
    const block = renderBaseline({ sessions: 2, observations: 100, pending: 60, flagged: true });
    expect(block).toContain('60 new observation(s) since the last optimization');
    expect(block).toContain('abs optimize');
  });
});

describe('handleSessionStart', () => {
  it('wraps the baseline in the SessionStart additionalContext envelope', async () => {
    const line = await handleSessionStart(
      { source: 'startup' },
      { gatherFacts: async () => ({ sessions: 1, observations: 10, pending: 0, flagged: false }) },
    );
    expect(line).not.toBeUndefined();
    const parsed = JSON.parse(line as string);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('persistent memory active');
  });

  it('returns undefined (injects nothing) for an empty store', async () => {
    const line = await handleSessionStart(
      {},
      { gatherFacts: async () => ({ sessions: 0, observations: 0, pending: 0, flagged: false }) },
    );
    expect(line).toBeUndefined();
  });
});
