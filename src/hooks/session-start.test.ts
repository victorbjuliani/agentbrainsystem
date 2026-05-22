import { describe, expect, it } from 'vitest';
import { handleSessionStart, renderBaseline, renderNotice } from './session-start.js';

/** Extract the injected additionalContext from a SessionStart hook output line. */
function injected(line: string | undefined): string {
  if (line === undefined) return '';
  return JSON.parse(line).hookSpecificOutput.additionalContext as string;
}

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

describe('renderNotice (memory transparency)', () => {
  it('names the folder, instructs telling the user once, and gives the MCP skip path', () => {
    const block = renderNotice('sess-1', '/Users/me/Devs/foo');
    expect(block).toContain('"foo"'); // the folder name (basename of cwd)
    expect(block).toContain('saved'); // it WILL be saved (default)
    expect(block).toContain('ONCE'); // tell the user once
    expect(block).toContain('set_session_project');
    expect(block).toContain('session="sess-1"');
    expect(block).toContain('skip');
    // No project-name choice is offered anymore (folder is the project).
    expect(block).not.toContain('new name');
    expect(block).not.toContain('action="set"');
  });

  it('returns nothing without a session id (no fulfillable skip instruction)', () => {
    expect(renderNotice('', '/Users/me/Devs/foo')).toBe('');
  });

  it('returns nothing without a cwd (cannot name the project)', () => {
    expect(renderNotice('sess-2', undefined)).toBe('');
  });
});

describe('handleSessionStart — memory notice', () => {
  const noticeFacts = {
    sessions: 1,
    observations: 5,
    pending: 0,
    flagged: false,
    hasBinding: false,
  };

  it('injects the notice when a session id + cwd are present and no binding exists', async () => {
    const line = await handleSessionStart(
      { sessionId: 'sess-1', cwd: '/Users/me/Devs/foo', source: 'startup' },
      { gatherFacts: async () => noticeFacts },
    );
    const ctx = injected(line);
    expect(ctx).toContain('persistent memory active'); // baseline still present
    expect(ctx).toContain('"foo"'); // notice names the folder
    expect(ctx).toContain('session="sess-1"');
  });

  it('suppresses the notice when a binding already exists (decision made)', async () => {
    const line = await handleSessionStart(
      { sessionId: 'sess-1', cwd: '/Users/me/Devs/foo', source: 'resume' },
      { gatherFacts: async () => ({ ...noticeFacts, hasBinding: true }) },
    );
    const ctx = injected(line);
    expect(ctx).toContain('persistent memory active');
    expect(ctx).not.toContain('saved to');
  });

  it('suppresses the notice when the payload has no session id (fail-safe)', async () => {
    const line = await handleSessionStart(
      { cwd: '/Users/me/Devs/foo', source: 'startup' },
      { gatherFacts: async () => noticeFacts },
    );
    expect(injected(line)).not.toContain('set_session_project');
  });

  it('still injects the notice on a brand-new (empty) store', async () => {
    const line = await handleSessionStart(
      { sessionId: 'sess-new', cwd: '/Users/me/Devs/foo', source: 'startup' },
      {
        gatherFacts: async () => ({
          sessions: 0,
          observations: 0,
          pending: 0,
          flagged: false,
          hasBinding: false,
        }),
      },
    );
    const ctx = injected(line);
    expect(ctx).not.toContain('persistent memory active'); // empty store → no baseline
    expect(ctx).toContain('"foo"'); // but the notice still fires
  });
});
