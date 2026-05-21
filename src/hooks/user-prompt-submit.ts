/**
 * UserPromptSubmit hook handler (#19) — placeholder wired in #15's dispatcher.
 *
 * Implemented in #19: FTS-first per-prompt recall (no embedding cold-load, per
 * ADR-0005) injected via `additionalContext`. Until then this is a no-op so the
 * dispatcher and the non-fatal contract are stable.
 */
import type { HookPayload } from './payload.js';

export async function handleUserPromptSubmit(_payload: HookPayload): Promise<string | undefined> {
  return undefined;
}
