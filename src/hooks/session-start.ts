/**
 * SessionStart hook handler (#16) — baseline context injection + staleness flag.
 *
 * When a Claude Code session starts, Claude Code runs this with the payload on
 * stdin. We inject a small baseline block ($0, no LLM, no embedding) so the agent
 * begins each session aware that a persistent memory exists and how fresh it is:
 *
 *   - store stats (sessions / observations) — proof the memory is populated;
 *   - a pending-optimization staleness flag ("N optimizations pending") computed
 *     from a kv_meta cursor (`optimize:cursorObsId`) counting observations added
 *     since the last optimization. The flag only COUNTS — it never runs the
 *     optimizer (that is #21).
 *
 * Opened with `ensure:false`: SessionStart must NOT trigger an index rebuild or a
 * model cold-load on the interactive critical path (same discipline as the UI #11
 * and ADR-0005). On any failure the runner swallows it (ADR-0004) and the session
 * starts with no injected baseline — never blocked.
 */
import { openMemory } from '../memory.js';
import { buildContextOutput, type HookPayload } from './payload.js';
import { evaluateStaleness, OPTIMIZE_CURSOR_KEY } from './staleness.js';

export interface SessionStartFacts {
  sessions: number;
  observations: number;
  pending: number;
  flagged: boolean;
}

export interface SessionStartDeps {
  /** Injection seam for tests — defaults to reading the real store read-only. */
  gatherFacts?: () => Promise<SessionStartFacts>;
}

/** Read store stats + staleness without mutating or loading any model. */
async function gatherFactsFromStore(): Promise<SessionStartFacts> {
  const memory = await openMemory(undefined, { ensure: false });
  try {
    const counts = memory.store.counts();
    const cursorRaw = memory.store.getMeta(OPTIMIZE_CURSOR_KEY);
    const pending = memory.store.countObservationsSince(
      cursorRaw ? Number.parseInt(cursorRaw, 10) || 0 : 0,
    );
    const { flagged } = evaluateStaleness(cursorRaw, pending);
    return { sessions: counts.sessions, observations: counts.observations, pending, flagged };
  } finally {
    memory.close();
  }
}

/** Render the baseline block. Empty store → no block (returns ''). */
export function renderBaseline(facts: SessionStartFacts): string {
  if (facts.observations === 0) return '';
  const lines = [
    'agentbrainsystem — persistent memory active.',
    `Stored: ${facts.observations} observation(s) across ${facts.sessions} session(s).`,
  ];
  if (facts.flagged) {
    lines.push(
      `Staleness: ${facts.pending} new observation(s) since the last optimization — ` +
        'consider running `abs optimize` to distill them into durable lessons.',
    );
  }
  return lines.join('\n');
}

/**
 * Build the SessionStart context line (or undefined when there's nothing to inject).
 * Throws on failure — the runner swallows it.
 */
export async function handleSessionStart(
  _payload: HookPayload,
  deps: SessionStartDeps = {},
): Promise<string | undefined> {
  const facts = deps.gatherFacts ? await deps.gatherFacts() : await gatherFactsFromStore();
  const block = renderBaseline(facts);
  return buildContextOutput('SessionStart', block) ?? undefined;
}
