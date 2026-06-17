import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemory } from '../memory.js';
import type { SessionStartFacts } from './session-start.js';
import {
  AUTO_DISTILL_NOTICE_SHOWN_KEY,
  handleSessionStart,
  renderAutoDistillNotice,
  renderBaseline,
  renderNotice,
} from './session-start.js';

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
    showAutoDistillNotice: false,
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

  it('raw-pending + NO LLM → strengthened nudge: run `abs setup` + ~99%-undistilled framing', () => {
    const block = renderBaseline(
      facts({ rawPending: 30, rawSessions: 2, rawFlagged: true, hasLlm: false }),
    );
    expect(block).toContain('not yet distilled');
    // Strengthened copy (ADR-0018): point the user at the guided setup step explicitly,
    // keep the env-var + consolidate escape hatches, and frame the cost.
    expect(block).toContain('abs setup');
    expect(block).toContain('ABS_LLM_BASE_URL');
    expect(block).toContain('abs consolidate');
    expect(block).toMatch(/99%/);
  });

  it('raw-pending + LLM → auto-distill copy stays unchanged (regression — no `abs setup` nudge)', () => {
    const block = renderBaseline(
      facts({ rawPending: 30, rawSessions: 2, rawFlagged: true, hasLlm: true }),
    );
    expect(block).toContain('auto-distill');
    expect(block).not.toContain('abs setup');
    expect(block).not.toMatch(/99%/);
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

describe('renderAutoDistillNotice (one-time auto-distill spend notice, #138/§3)', () => {
  it('states all three required clauses: per-session token spend, background+auto-memory-only, exact opt-out', () => {
    const block = renderAutoDistillNotice();
    // (a) it spends LLM tokens — one consolidate call per qualifying session that ends.
    expect(block).toContain('token');
    expect(block).toContain('one consolidate call per qualifying session');
    // (b) background, writes only the local auto-memory file, never CLAUDE.md.
    expect(block).toContain('background');
    expect(block).toContain('auto-memory');
    expect(block).toContain('CLAUDE.md');
    // (c) the exact opt-out env var.
    expect(block).toContain('ABS_AUTO_DISTILL=0');
  });
});

describe('handleSessionStart — auto-distill notice wiring', () => {
  it('injects the auto-distill notice as a third block when facts flag it', async () => {
    const line = await handleSessionStart(
      { sessionId: 'sess-1', cwd: '/Users/me/Devs/foo', source: 'startup' },
      {
        gatherFacts: async () =>
          facts({ observations: 10, hasBinding: false, showAutoDistillNotice: true }),
      },
    );
    const ctx = injected(line);
    expect(ctx).toContain('persistent memory active'); // baseline
    expect(ctx).toContain('"foo"'); // project notice
    expect(ctx).toContain('ABS_AUTO_DISTILL=0'); // the auto-distill notice
    expect(ctx).toContain('one consolidate call per qualifying session');
  });

  it('does NOT inject the auto-distill notice when facts do not flag it', async () => {
    const line = await handleSessionStart(
      { sessionId: 'sess-1', cwd: '/Users/me/Devs/foo', source: 'startup' },
      {
        gatherFacts: async () =>
          facts({ observations: 10, hasBinding: false, showAutoDistillNotice: false }),
      },
    );
    expect(injected(line)).not.toContain('ABS_AUTO_DISTILL=0');
  });
});

describe('gatherFactsFromStore — one-time auto-distill notice (#138, real store)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-ss-notice-'));
    process.env.ABS_HOME = dir;
    process.env.ABS_LLM_BASE_URL = 'http://localhost:9/v1';
    process.env.ABS_LLM_MODEL = 'fake-model';
    delete process.env.ABS_AUTO_DISTILL; // default ON
  });
  afterEach(() => {
    delete process.env.ABS_HOME;
    delete process.env.ABS_LLM_BASE_URL;
    delete process.env.ABS_LLM_MODEL;
    delete process.env.ABS_AUTO_DISTILL;
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires the notice ONCE (LLM + auto-distill on), then suppresses it and sets the kv_meta flag', async () => {
    // Materialize the store dir first (so the flag write below targets the same db).
    (await openMemory(undefined, { ensure: false })).close();
    const payload = { sessionId: 'sess-1', cwd: dir, source: 'startup' as const };

    const first = injected(await handleSessionStart(payload));
    expect(first).toContain('ABS_AUTO_DISTILL=0'); // fired the first time

    const mem = await openMemory(undefined, { ensure: false });
    try {
      expect(mem.store.getMeta(AUTO_DISTILL_NOTICE_SHOWN_KEY)).not.toBeNull(); // flag set on fire
    } finally {
      mem.close();
    }

    const second = injected(await handleSessionStart(payload));
    expect(second).not.toContain('ABS_AUTO_DISTILL=0'); // never re-injected
  });

  it('an EMPTY-STRING sessionId does NOT consume the one-shot flag (#138 FIX3)', async () => {
    // A degenerate SessionStart with `sessionId: ''` has nothing to auto-distill, so it
    // must NOT fire the notice NOR burn the install-wide one-shot flag — otherwise the
    // next REAL session would silently never see the spend notice.
    (await openMemory(undefined, { ensure: false })).close();
    const empty = injected(
      await handleSessionStart({ sessionId: '', cwd: dir, source: 'startup' }),
    );
    expect(empty).not.toContain('ABS_AUTO_DISTILL=0'); // never fired on the empty id

    // The flag is still UNSET, so a subsequent real session fires the notice as normal.
    const mem = await openMemory(undefined, { ensure: false });
    try {
      expect(mem.store.getMeta(AUTO_DISTILL_NOTICE_SHOWN_KEY)).toBeNull();
    } finally {
      mem.close();
    }
    const real = injected(
      await handleSessionStart({ sessionId: 'sess-real', cwd: dir, source: 'startup' }),
    );
    expect(real).toContain('ABS_AUTO_DISTILL=0'); // the real session still gets it
  });

  it('never fires when auto-distill is opted out (ABS_AUTO_DISTILL=0)', async () => {
    process.env.ABS_AUTO_DISTILL = '0';
    (await openMemory(undefined, { ensure: false })).close();
    const line = await handleSessionStart({ sessionId: 'sess-1', cwd: dir, source: 'startup' });
    expect(injected(line)).not.toContain('ABS_AUTO_DISTILL=0');
  });

  it('never fires when no LLM is configured', async () => {
    delete process.env.ABS_LLM_BASE_URL;
    delete process.env.ABS_LLM_MODEL;
    (await openMemory(undefined, { ensure: false })).close();
    const line = await handleSessionStart({ sessionId: 'sess-1', cwd: dir, source: 'startup' });
    expect(injected(line)).not.toContain('ABS_AUTO_DISTILL=0');
  });
});
