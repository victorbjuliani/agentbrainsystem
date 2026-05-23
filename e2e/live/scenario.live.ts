import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertBehavioral, assertInjection } from './assert.js';
import { runClaude } from './driver.js';
import { EXPECTED_KEYWORDS, SESSION_A_PROMPT, SESSION_B_PROMPT } from './prompts.js';
import { type LiveScaffold, makeScaffold } from './setup.js';

const LIVE = process.env.ABS_LIVE_CC === '1';
const d = LIVE ? describe : describe.skip;

d('live Claude Code memory loop (opt-in: ABS_LIVE_CC=1)', () => {
  let s: LiveScaffold;
  beforeAll(() => {
    s = makeScaffold();
  });
  afterAll(() => s?.cleanup());

  it('captures Session A, recalls + injects into Session B, and the model uses it', async () => {
    // Session A — capture (SessionEnd ingests on clean exit).
    const a = await runClaude({
      prompt: SESSION_A_PROMPT,
      cwd: s.proj,
      absHome: s.absHome,
      settingsPath: s.settingsPath,
    });
    expect(a.code).toBe(0);

    // Capture gate — the store must now hold the decisions.
    expect(s.observationCount()).toBeGreaterThan(0);

    // Session B — recall + injection (deterministic) + use (behavioral).
    const b = await runClaude({
      prompt: SESSION_B_PROMPT,
      cwd: s.proj,
      absHome: s.absHome,
      settingsPath: s.settingsPath,
      streamHooks: true,
    });
    expect(b.code).toBe(0);

    // BLOCKING GATE (deterministic): the recalled-memory fence carried the full money
    // decision verbatim. This is the proof that recall happened and was injected.
    const inj = assertInjection(b.events.promptSubmitInjection, EXPECTED_KEYWORDS.money);
    expect(inj.ok, `injection missing: ${inj.missing.join(', ')}`).toBe(true);

    // BLOCKING (behavioral core): the answer used the recalled concept. We assert only the
    // core token (`cents`) because LLM phrasing varies — that the model reached for cents at
    // all, in a fresh session, only makes sense if it consumed the injected memory.
    const core = assertBehavioral(b.events.assistantText, [/cent/i]);
    expect(core.ok, `behavioral core missing: ${core.missing.join(', ')}`).toBe(true);

    // SOFT (corroborating): the fuller money + token sets. Phrasing-dependent, so by default
    // a miss only warns; set ABS_LIVE_STRICT=1 to make these blocking too.
    const full = assertBehavioral(b.events.assistantText, [
      ...EXPECTED_KEYWORDS.money,
      ...EXPECTED_KEYWORDS.token,
    ]);
    if (!full.ok) {
      const msg = `behavioral soft miss (non-blocking): ${full.missing.join(', ')}`;
      if (process.env.ABS_LIVE_STRICT === '1') expect(full.ok, msg).toBe(true);
      else console.warn(`⚠ ${msg}`);
    }
  }, 180_000);
});
