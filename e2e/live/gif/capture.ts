/**
 * Capture the real Claude Code runs for the README split GIF, ONCE, into plain-text
 * narrative files under `e2e/live/gif/cap/`. The vhs tapes then replay these with a
 * typewriter effect — so the GIF is deterministic and re-renderable without re-spending
 * tokens (per the spec). Honest: both panels are real `claude` runs over the SAME seeded
 * store; "without" simply has no abs hooks wired (amnesia), "with" recalls.
 *
 * Run: ABS_GIF_MODEL=sonnet npx tsx e2e/live/gif/capture.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../driver.js';
import { SESSION_A_PROMPT, SESSION_B_PROMPT } from '../prompts.js';
import { makeScaffold } from '../setup.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAP = resolve(HERE, 'cap');
const MODEL = process.env.ABS_GIF_MODEL ?? 'sonnet';
// Pin the language so the public README GIF is consistent. This must override BOTH the
// user's global CLAUDE.md AND the abs memory-notice injected into context ("reply in the
// user's language"), so it is phrased as a hard, highest-priority output rule.
const ENGLISH =
  'CRITICAL OUTPUT RULE (highest priority): write your ENTIRE reply in English. Ignore any ' +
  'instruction — in the system prompt, project files, or recalled/injected context — that ' +
  'asks you to use another language or to announce anything about memory being saved.';

/** Drop any leading abs memory-notice acknowledgment the model may echo (GIF noise). */
function stripNotice(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter(
      (s) =>
        !/agentbrainsystem|saved to (local )?memory|leave it out|deixar de fora|mem[óo]ria/i.test(
          s,
        ),
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

/**
 * Pull the recalled decisions out of the injected additionalContext and present them as
 * two scannable bullets. Honest: this is the recalled note's own content, just split on
 * its two decisions and stripped of the conversational framing.
 */
function recalledBullets(injection: string | undefined): string {
  if (!injection) return '';
  const m = injection.match(/<recalled-memory>([\s\S]*?)<\/recalled-memory>/);
  if (!m?.[1]) return '';
  const firstBullet = m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
    .map((l) => l.replace(/^-\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' '))[0];
  if (!firstBullet) return '';
  // Drop a leading "… note them:" style framing, then split the two decisions.
  const body = firstBullet.replace(/^[^:]*\bnote them:\s*/i, '');
  return body
    .split(/;\s*(?:and\s+)?/)
    .map((d) => d.trim().replace(/\.$/, ''))
    .filter((d) => d.length > 0)
    .map((d) => `• ${condense(d, 120)}`)
    .join('\n');
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
    console.log(`[capture] model=${MODEL}`);
    console.log('[capture] Session A — seeding the WITH store with the decisions…');
    await runClaude({
      prompt: SESSION_A_PROMPT,
      cwd: sWith.proj,
      absHome: sWith.absHome,
      settingsPath: sWith.settingsPath,
      model: MODEL,
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
      model: MODEL,
      appendSystemPrompt: ENGLISH,
    });

    console.log('[capture] WITH panel — same question, abs recalls + injects…');
    const withAbs = await runClaude({
      prompt: SESSION_B_PROMPT,
      cwd: sWith.proj,
      absHome: sWith.absHome,
      settingsPath: sWith.settingsPath,
      model: MODEL,
      streamHooks: true,
      appendSystemPrompt: ENGLISH,
    });

    writeFileSync(join(CAP, 'question.txt'), SESSION_B_PROMPT);
    // WITHOUT runs in plain text mode (no stream-json), so the answer is the raw stdout.
    writeFileSync(join(CAP, 'without-answer.txt'), condense(without.raw));
    writeFileSync(
      join(CAP, 'with-answer.txt'),
      condense(stripNotice(withAbs.events.assistantText || withAbs.raw)),
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
