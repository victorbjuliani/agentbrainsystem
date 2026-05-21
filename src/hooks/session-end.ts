/**
 * SessionEnd hook handler (#15) — auto-ingest on session close, $0, no LLM.
 *
 * When a Claude Code session ends, Claude Code runs this with the hook payload on
 * stdin. We trigger the EXISTING incremental ingest (`ingestClaudeProjects`), which
 * reuses its byte-cursor so only the just-finished session's new transcript lines
 * are read — nothing is re-ingested. The default local embedding provider indexes
 * them ($0, offline); we NEVER call consolidate/LLM here (that stays opt-in, #12).
 *
 * SessionEnd cannot inject context, so this handler returns `undefined` (no stdout).
 * It runs behind `runHookSafely`, so any failure here is swallowed and the session
 * is never blocked (ADR-0004). We open memory with the default ensure gate so a
 * drifted index self-heals, then always close the store.
 */
import { ingestClaudeProjects } from '../ingest/index.js';
import { openMemory } from '../memory.js';
import type { HookPayload } from './payload.js';

export interface SessionEndDeps {
  /** Injection seam for tests — defaults to the real openMemory + ingest. */
  ingest?: () => Promise<void>;
}

/**
 * Run the auto-ingest. Resolves `undefined` (SessionEnd injects nothing). Throws on
 * failure — the caller (`runHookSafely`) is responsible for swallowing it.
 */
export async function handleSessionEnd(
  _payload: HookPayload,
  deps: SessionEndDeps = {},
): Promise<undefined> {
  if (deps.ingest) {
    await deps.ingest();
    return undefined;
  }
  const memory = await openMemory();
  try {
    await ingestClaudeProjects(memory);
  } finally {
    memory.close();
  }
  return undefined;
}
