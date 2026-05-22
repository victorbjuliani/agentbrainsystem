/**
 * SessionStart hook handler (#16 baseline + #52 project picker).
 *
 * When a Claude Code session starts, Claude Code runs this with the payload on
 * stdin. We inject two $0/offline blocks (no LLM, no embedding):
 *
 *   1. Baseline (#16): store stats (sessions / observations) + a pending-
 *      optimization staleness flag, so the agent begins each session aware a
 *      persistent memory exists and how fresh it is. The flag only COUNTS.
 *
 *   2. Memory notice (#52, transparency): the project is ALWAYS the session's
 *      folder (the cwd) — no name to choose — so we don't ask which project. We
 *      inject a soft notice telling Claude to let the user know, once, that this
 *      session is being saved to memory under that folder, and that they can ask
 *      to leave it out (recorded via the `set_session_project` MCP tool, action
 *      `skip`, or the CLI `abs project --skip`). Soft by nature (hooks can't force
 *      the model); the UserPromptSubmit hook reinforces it on the first prompt.
 *      Suppressed once a decision binding already exists for the session (skip
 *      already chosen), or when the payload has no session id / cwd (fail-safe).
 *
 * Opened with `ensure:false`: SessionStart must NOT trigger an index rebuild or a
 * model cold-load on the interactive critical path (same discipline as the UI #11
 * and ADR-0005). On any failure the runner swallows it (ADR-0004) and the session
 * starts with no injection — never blocked.
 */
import { basename } from 'node:path';
import { readBinding } from '../ingest/index.js';
import { openMemory } from '../memory.js';
import { buildContextOutput, type HookPayload } from './payload.js';
import { evaluateStaleness, OPTIMIZE_CURSOR_KEY } from './staleness.js';

export interface SessionStartFacts {
  sessions: number;
  observations: number;
  pending: number;
  flagged: boolean;
  /** Whether a session→project binding already exists for this session (#52). */
  hasBinding?: boolean;
}

export interface SessionStartDeps {
  /** Injection seam for tests — defaults to reading the real store read-only. */
  gatherFacts?: () => Promise<SessionStartFacts>;
}

/**
 * Read store stats + staleness (+ picker facts when a `sessionId` is given) without
 * mutating or loading any model. One `ensure:false` open serves both blocks.
 */
async function gatherFactsFromStore(sessionId?: string): Promise<SessionStartFacts> {
  const memory = await openMemory(undefined, { ensure: false });
  try {
    const counts = memory.store.counts();
    const cursorRaw = memory.store.getMeta(OPTIMIZE_CURSOR_KEY);
    const pending = memory.store.countObservationsSince(
      cursorRaw ? Number.parseInt(cursorRaw, 10) || 0 : 0,
    );
    const { flagged } = evaluateStaleness(cursorRaw, pending);
    const facts: SessionStartFacts = {
      sessions: counts.sessions,
      observations: counts.observations,
      pending,
      flagged,
    };
    if (sessionId) {
      facts.hasBinding = readBinding(memory.store, sessionId) !== null;
    }
    return facts;
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
 * Render the memory-notice block (#52, transparency). The project is always the
 * session's folder (the cwd basename) — there is no name to pick — so this is a
 * soft notice, not a question: tell the user, once, that this session is being
 * saved to memory under that folder, and how to leave it out. Renders independently
 * of the baseline so it fires even on a brand-new (empty) store. Returns '' when
 * there is no usable session id or cwd (can't name the project / key the skip).
 */
export function renderNotice(sessionId: string, cwd: string | undefined): string {
  if (!sessionId || !cwd) return '';
  const folder = basename(cwd);
  return [
    'agentbrainsystem — memory notice.',
    `This session will be saved to local memory under project "${folder}" (its folder) when it ends.`,
    'ACTION REQUIRED: in your FIRST reply this session, let the user know — in their language, ' +
      'in one short line, alongside your normal answer — that this session is being saved to ' +
      `agentbrainsystem memory under "${folder}", and that they can ask you to leave it out. ` +
      'Say it ONCE; do not repeat it on later turns.',
    'If the user asks to leave this session out of memory, call the `set_session_project` MCP ' +
      `tool with session="${sessionId}" and action="skip" (or run \`abs project --skip\`).`,
  ].join('\n');
}

/**
 * Build the SessionStart context line (or undefined when there's nothing to inject).
 * Concatenates the baseline (#16) and the project picker (#52) into one injection
 * (the runner emits a single stdout line). Throws on failure — the runner swallows it.
 */
export async function handleSessionStart(
  payload: HookPayload,
  deps: SessionStartDeps = {},
): Promise<string | undefined> {
  const facts = deps.gatherFacts
    ? await deps.gatherFacts()
    : await gatherFactsFromStore(payload.sessionId);

  const blocks: string[] = [];
  const baseline = renderBaseline(facts);
  if (baseline) blocks.push(baseline);

  // Notice: only when we have a session id to key the skip on AND no binding
  // already records a decision (suppressed once the user has chosen to skip).
  if (payload.sessionId && facts.hasBinding === false) {
    const notice = renderNotice(payload.sessionId, payload.cwd);
    if (notice) blocks.push(notice);
  }

  return buildContextOutput('SessionStart', blocks.join('\n\n')) ?? undefined;
}
