import { describe, expect, it } from 'vitest';
import type { SessionStartFacts } from './session-start.js';
import { handleSessionStart, renderBaseline, renderNotice } from './session-start.js';

/** Extract the injected additionalContext from a SessionStart hook output line. */
function injected(line: string | undefined): string {
  if (line === undefined) return '';
  return JSON.parse(line).hookSpecificOutput.additionalContext as string;
}

/** Two-signal facts with both signals clear by default; override per test. */
function facts(overrides: Partial<SessionStartFacts> = {}): SessionStartFacts {
  return {
    sessions: 2,
    observations: 40,
    rawPending: 0,
    rawSessions: 0,
    rawFlagged: false,
    lessonsPending: 0,
    decisionsPending: 0,
    consolidatedFlagged: false,
    hasLlm: true,
    ...overrides,
  };
}

describe('renderBaseline', () => {
  it('emits no block for an empty store', () => {
    expect(renderBaseline(facts({ sessions: 0, observations: 0 }))).toBe('');
  });

  it('reports stats without any staleness line when both signals clear', () => {
    const block = renderBaseline(facts());
    expect(block).toContain('40 observation(s) across 2 session(s)');
    expect(block).not.toContain('Staleness');
  });

  it('raw-pending + LLM → "not yet distilled" and auto handles it', () => {
    const block = renderBaseline(
      facts({ rawPending: 30, rawSessions: 2, rawFlagged: true, hasLlm: true }),
    );
    expect(block).toContain('30 turn(s) across 2 session(s) not yet distilled');
    expect(block).toContain('auto-distill');
    expect(block).not.toContain('abs consolidate');
  });

  it('raw-pending + NO LLM → configure an LLM / run `abs consolidate`', () => {
    const block = renderBaseline(
      facts({ rawPending: 30, rawSessions: 2, rawFlagged: true, hasLlm: false }),
    );
    expect(block).toContain('not yet distilled');
    expect(block).toContain('ABS_LLM_BASE_URL');
    expect(block).toContain('abs consolidate');
  });

  it('consolidated-pending (decisions only) → run `abs optimize`', () => {
    const block = renderBaseline(
      facts({ lessonsPending: 0, decisionsPending: 4, consolidatedFlagged: true }),
    );
    expect(block).toContain('0 lesson(s) + 4 decision(s) pending promotion');
    expect(block).toContain('abs optimize');
  });

  it('both signals clear → no staleness line; old single-cursor copy is gone', () => {
    const block = renderBaseline(facts());
    expect(block).not.toContain('Staleness');
    // The old "N new observation(s) since the last optimization" line is removed.
    expect(block).not.toContain('since the last optimization');
  });

  it('surfaces a degraded note when the index is stale (#101)', () => {
    const block = renderBaseline(facts({ indexStale: true }));
    expect(block).toContain('DEGRADED');
    expect(block).toContain('abs doctor');
  });

  it('omits the degraded note when the index is healthy', () => {
    const block = renderBaseline(facts({ indexStale: false }));
    expect(block).not.toContain('DEGRADED');
  });
});

describe('handleSessionStart', () => {
  it('wraps the baseline in the SessionStart additionalContext envelope', async () => {
    const line = await handleSessionStart(
      { source: 'startup' },
      { gatherFacts: async () => facts({ sessions: 1, observations: 10 }) },
    );
    expect(line).not.toBeUndefined();
    const parsed = JSON.parse(line as string);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('persistent memory active');
  });

  it('returns undefined (injects nothing) for an empty store', async () => {
    const line = await handleSessionStart(
      {},
      { gatherFacts: async () => facts({ sessions: 0, observations: 0 }) },
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
  const noticeFacts = facts({ sessions: 1, observations: 5, hasBinding: false });

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
        gatherFacts: async () => facts({ sessions: 0, observations: 0, hasBinding: false }),
      },
    );
    const ctx = injected(line);
    expect(ctx).not.toContain('persistent memory active'); // empty store → no baseline
    expect(ctx).toContain('"foo"'); // but the notice still fires
  });

  it('renderNotice echoes the (already-namespaced) id it is handed — no re-derivation (R4)', async () => {
    const line = await handleSessionStart(
      { sessionId: 'codex:019e2658', cwd: '/Users/me/Devs/foo', source: 'startup' },
      { gatherFacts: async () => noticeFacts },
    );
    const ctx = injected(line);
    expect(ctx).toContain('session="codex:019e2658"');
    expect(ctx).not.toContain('codex:codex:'); // handler does not double-prefix
  });
});
