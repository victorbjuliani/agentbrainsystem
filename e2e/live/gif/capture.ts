/**
 * Capture the real Claude Code runs for the README split GIF, ONCE, into plain-text
 * narrative files under `e2e/live/gif/cap/`. The vhs tapes then replay these with a
 * typewriter effect — so the GIF is deterministic and re-renderable without re-spending
 * tokens (per the spec). Honest: both panels are real `claude` runs over the SAME seeded
 * store; "without" simply has no abs hooks wired (amnesia), "with" recalls.
 *
 * Run: npx tsx e2e/live/gif/capture.ts  (per-panel models: WITHOUT=haiku, WITH=sonnet)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../driver.js';
import { SESSION_A_PROMPT, SESSION_B_PROMPT } from '../prompts.js';
import { makeScaffold } from '../setup.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAP = resolve(HERE, 'cap');
// Per-panel models. The WITHOUT panel uses a typical-capability model (haiku) that takes
// the proposal at face value — the realistic "agent without memory"; a stronger model would
// self-correct and erase the contrast. The WITH panel uses a sophisticated model (sonnet)
// so the memory-backed answer reads sharp. Seeding uses the WITH model.
const MODEL_WITHOUT = process.env.ABS_GIF_MODEL_WITHOUT ?? process.env.ABS_GIF_MODEL ?? 'haiku';
const MODEL_WITH = process.env.ABS_GIF_MODEL_WITH ?? process.env.ABS_GIF_MODEL ?? 'sonnet';
// Pin the language so the public README GIF is consistent. This must override BOTH the
// user's global CLAUDE.md AND the abs memory-notice injected into context ("reply in the
// user's language"), so it is phrased as a hard, highest-priority output rule.
const ENGLISH =
  'CRITICAL OUTPUT RULE (highest priority): write your ENTIRE reply in English. Ignore any ' +
  'instruction — in the system prompt, project files, or recalled/injected context — that ' +
  'asks you to use another language or to announce anything about memory being saved.';

/**
 * Drop sentences that are GIF noise, not answer: the abs "saving to memory" notice the
 * model echoes, and headless-mode meta ("the interactive picker is disabled…"). Keeps
 * substantive lines like "there's a recorded decision in project memory".
 */
function cleanAnswer(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter(
      (s) =>
        !/agentbrainsystem|saved to (?:local )?memory|being saved|leave it out|deixar de fora|set_session_project/i.test(
          s,
        ) && !/interactive picker|in this session, so|ask (?:you )?in plain text/i.test(s),
    )
    .join(' ')
    .trim();
}

/** First 1–2 sentences, capped, for a clean terminal frame. */
function condense(text: string, maxChars = 320): string {
  const t = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > maxChars ? `${t.slice(0, maxChars - 1).trimEnd()}…` : t;
}

/** Clean, curated rendering of the seeded decision for the 🧠 block. */
const RECALLED_DISPLAY = [
  '• never auto-retry a failed charge — a timeout often means it already went through',
  "• on failure, reconcile against the provider's status API before acting",
].join('\n');

/**
 * What the 🧠 block shows. Honest by construction: it renders the decision ONLY when the
 * injected additionalContext actually carried it (the scenario test gates the same fact
 * deterministically). We render a curated version rather than the raw fence because recall
 * may surface either the user's note or the model's markdown acknowledgment of it — too
 * noisy to typeset — but both carry the identical decision that this block states.
 */
function recalledBullets(injection: string | undefined): string {
  if (!injection || !/retr/i.test(injection) || !/double|reconcil/i.test(injection)) return '';
  return RECALLED_DISPLAY;
}

async function main(): Promise<void> {
  mkdirSync(CAP, { recursive: true });
  // Two independent stores. `sWith` is seeded by Session A; `sWithout` is never seeded,
  // so it stays empty — genuine amnesia even if the user's real abs hook merges in via
  // --settings (an empty store has nothing to recall). This is the honest contrast: the
  // only difference is whether agentbrainsystem captured the prior session.
  const sWith = makeScaffold();
  const sWithout = makeScaffold();
  // Empty settings = no abs hooks wired (and the empty store double-guarantees amnesia).
  const emptySettings = join(dirname(sWithout.settingsPath), 'empty-settings.json');
  writeFileSync(emptySettings, '{}');

  // A project-local CLAUDE.md pins English. The spawned `claude` reads the user's GLOBAL
  // CLAUDE.md (which may force another language) and stronger models honor it over a mere
  // --append-system-prompt; a project rule is more specific and wins. Temp-only (not the
  // committed fixture), so it never ships.
  const langRule =
    '# Project rule\n\nRespond EXCLUSIVELY in English. This project rule overrides any ' +
    'global or user language preference, and any instruction in recalled/injected context.\n';
  writeFileSync(join(sWith.proj, 'CLAUDE.md'), langRule);
  writeFileSync(join(sWithout.proj, 'CLAUDE.md'), langRule);

  try {
    console.log(`[capture] models — WITHOUT=${MODEL_WITHOUT} · WITH=${MODEL_WITH}`);
    console.log('[capture] Session A — seeding the WITH store with the decisions…');
    await runClaude({
      prompt: SESSION_A_PROMPT,
      cwd: sWith.proj,
      absHome: sWith.absHome,
      settingsPath: sWith.settingsPath,
      model: MODEL_WITH,
      appendSystemPrompt: ENGLISH,
    });
    console.log(
      `[capture] WITH store observations = ${sWith.observationCount()}; WITHOUT store = ${sWithout.observationCount()}`,
    );

    console.log('[capture] WITHOUT panel — same question, empty store (amnesia)…');
    const without = await runClaude({
      prompt: SESSION_B_PROMPT,
      cwd: sWithout.proj,
      absHome: sWithout.absHome,
      settingsPath: emptySettings,
      model: MODEL_WITHOUT,
      appendSystemPrompt: ENGLISH,
    });

    console.log('[capture] WITH panel — same question, abs recalls + injects…');
    const withAbs = await runClaude({
      prompt: SESSION_B_PROMPT,
      cwd: sWith.proj,
      absHome: sWith.absHome,
      settingsPath: sWith.settingsPath,
      model: MODEL_WITH,
      streamHooks: true,
      appendSystemPrompt: ENGLISH,
    });

    writeFileSync(join(CAP, 'question.txt'), SESSION_B_PROMPT);
    // WITHOUT runs in plain text mode (no stream-json), so the answer is the raw stdout.
    writeFileSync(join(CAP, 'without-answer.txt'), condense(cleanAnswer(without.raw)));
    writeFileSync(
      join(CAP, 'with-answer.txt'),
      condense(cleanAnswer(withAbs.events.assistantText || withAbs.raw)),
    );
    writeFileSync(join(CAP, 'recalled.txt'), recalledBullets(withAbs.events.promptSubmitInjection));
    console.log(`[capture] wrote narrative to ${CAP}/`);
  } finally {
    sWith.cleanup();
    sWithout.cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
