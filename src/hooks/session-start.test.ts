import { describe, expect, it } from 'vitest';
import { handleSessionStart, renderBaseline, renderPicker } from './session-start.js';

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

describe('renderPicker (#52, F5)', () => {
  it('emits an imperative instruction naming the MCP tool + the explicit session id', () => {
    const block = renderPicker('sess-1', '/Users/me/Devs/foo', ['Alpha', 'Beta']);
    expect(block).toContain('set_session_project');
    expect(block).toContain('session="sess-1"');
    expect(block).toContain('SKIP');
    expect(block).toContain('confirmDelete=true'); // skip-with-stored-obs second call (Codex P1)
    expect(block).toContain('"-Users-me-Devs-foo"'); // auto slug suggestion
    expect(block).toContain('"foo"'); // basename new-name suggestion
    expect(block).toContain('"Alpha"'); // existing project listed
  });

  it('returns nothing without a session id (fail-safe — no unfulfillable instruction)', () => {
    expect(renderPicker('', '/x', [])).toBe('');
  });

  it('renders without cwd-derived suggestions when cwd is absent', () => {
    const block = renderPicker('sess-2', undefined, []);
    expect(block).toContain('set_session_project');
    expect(block).not.toContain('working dir');
  });
});

describe('handleSessionStart — project picker (#52)', () => {
  const pickerFacts = {
    sessions: 1,
    observations: 5,
    pending: 0,
    flagged: false,
    projects: ['Alpha'],
    hasBinding: false,
  };

  it('injects the picker when a session id is present and no binding exists', async () => {
    const line = await handleSessionStart(
      { sessionId: 'sess-1', cwd: '/Users/me/Devs/foo', source: 'startup' },
      { gatherFacts: async () => pickerFacts },
    );
    const ctx = injected(line);
    expect(ctx).toContain('persistent memory active'); // baseline still present
    expect(ctx).toContain('set_session_project'); // picker present
    expect(ctx).toContain('session="sess-1"');
  });

  it('suppresses the picker when a binding already exists (idempotent on resume)', async () => {
    const line = await handleSessionStart(
      { sessionId: 'sess-1', cwd: '/Users/me/Devs/foo', source: 'resume' },
      { gatherFacts: async () => ({ ...pickerFacts, hasBinding: true }) },
    );
    const ctx = injected(line);
    expect(ctx).toContain('persistent memory active');
    expect(ctx).not.toContain('set_session_project');
  });

  it('suppresses the picker when the payload has no session id (fail-safe)', async () => {
    const line = await handleSessionStart(
      { cwd: '/Users/me/Devs/foo', source: 'startup' },
      { gatherFacts: async () => pickerFacts },
    );
    expect(injected(line)).not.toContain('set_session_project');
  });

  it('still injects the picker on a brand-new (empty) store', async () => {
    const line = await handleSessionStart(
      { sessionId: 'sess-new', cwd: '/Users/me/Devs/foo', source: 'startup' },
      {
        gatherFacts: async () => ({
          sessions: 0,
          observations: 0,
          pending: 0,
          flagged: false,
          projects: [],
          hasBinding: false,
        }),
      },
    );
    const ctx = injected(line);
    expect(ctx).not.toContain('persistent memory active'); // empty store → no baseline
    expect(ctx).toContain('set_session_project'); // but the picker still fires
  });
});
