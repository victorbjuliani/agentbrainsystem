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

    // BLOCKING GATE (deterministic): the recalled-memory fence carried the seeded decision
    // verbatim. This is the proof that recall happened and was injected.
    const inj = assertInjection(b.events.promptSubmitInjection, EXPECTED_KEYWORDS.injection);
    expect(inj.ok, `injection missing: ${inj.missing.join(', ')}`).toBe(true);

    // BLOCKING (behavioral core): the answer ADOPTED the recalled approach (append-only /
    // separate table / computed) rather than the naive Order column the prompt proposed —
    // a divergence from the memory-less default that only makes sense if it used the memory.
    const core = assertBehavioral(b.events.assistantText, EXPECTED_KEYWORDS.behavioralCore);
    expect(core.ok, `behavioral core missing: ${core.missing.join(', ')}`).toBe(true);

    // SOFT (corroborating): the rationale (the production double-refund scar). Phrasing-
    // dependent, so by default a miss only warns; set ABS_LIVE_STRICT=1 to make it blocking.
    const soft = assertBehavioral(b.events.assistantText, EXPECTED_KEYWORDS.rationale);
    if (!soft.ok) {
      const msg = `behavioral soft miss (non-blocking): ${soft.missing.join(', ')}`;
      if (process.env.ABS_LIVE_STRICT === '1') expect(soft.ok, msg).toBe(true);
      else console.warn(`⚠ ${msg}`);
    }
  }, 180_000);
});
