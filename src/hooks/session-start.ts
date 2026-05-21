/**
 * SessionStart hook handler (#16) — placeholder wired in #15's dispatcher.
 *
 * Implemented in #16: injects a baseline context block ($0, no LLM) plus a
 * pending-optimization staleness flag computed from a kv_meta cursor. Until then
 * this is a no-op so the dispatcher (and the non-fatal contract) is stable.
 */
import type { HookPayload } from './payload.js';

export async function handleSessionStart(_payload: HookPayload): Promise<string | undefined> {
  return undefined;
}
