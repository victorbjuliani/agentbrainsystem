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
 *   2. Project picker (#52, F5): hooks can't prompt, so we inject an IMPERATIVE
 *      instruction telling Claude to ask the user which project this session
 *      belongs to (existing / new name / skip) and record it via the
 *      `set_session_project` MCP tool. Soft (we can't force Claude — the CLI
 *      `abs project` is the hard guarantee, #51). Suppressed once a decision
 *      binding already exists for the session (idempotent on resume), or when
 *      the payload carries no session id (fail-safe — no fulfillable instruction).
 *
 * Opened with `ensure:false`: SessionStart must NOT trigger an index rebuild or a
 * model cold-load on the interactive critical path (same discipline as the UI #11
 * and ADR-0005). On any failure the runner swallows it (ADR-0004) and the session
 * starts with no injection — never blocked.
 */
import { basename } from 'node:path';
import { readBinding } from '../ingest/index.js';
import { openMemory } from '../memory.js';
import { projectSlug } from '../optimize/targets.js';
import { buildContextOutput, type HookPayload } from './payload.js';
import { evaluateStaleness, OPTIMIZE_CURSOR_KEY } from './staleness.js';

export interface SessionStartFacts {
  sessions: number;
  observations: number;
  pending: number;
  flagged: boolean;
  /** Existing project labels (#52 picker). Undefined when not gathered. */
  projects?: string[];
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
      facts.projects = memory.store.listProjects();
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
 * Render the project-picker block (#52, F5). An imperative instruction for Claude
 * to ask the user which project this session belongs to and record it via the
 * `set_session_project` MCP tool (passing the explicit session id so the tool
 * never has to guess). Renders independently of the baseline so it fires even on
 * a brand-new (empty) store. Returns '' when there's no usable session id.
 */
export function renderPicker(
  sessionId: string,
  cwd: string | undefined,
  projects: string[],
): string {
  if (!sessionId) return '';
  const lines = ['agentbrainsystem — choose this session’s project (memory hygiene).'];
  if (cwd) {
    lines.push(`This session’s working dir: ${cwd}`);
    lines.push(`  • accept the auto-derived project: "${projectSlug(cwd)}"`);
    lines.push(`  • or a clean new label, suggested: "${basename(cwd)}"`);
  }
  if (projects.length > 0) {
    lines.push(`Existing projects you can link to: ${projects.map((p) => `"${p}"`).join(', ')}`);
  }
  lines.push(
    'ACTION REQUIRED: ask the user which project this session belongs to — link an ' +
      'existing one, use a new name, accept the auto-derived one, or SKIP (do not store ' +
      'this session). Then record their choice by calling the `set_session_project` MCP ' +
      `tool with session="${sessionId}" and either action="set" + project="<name>" or ` +
      'action="skip". If the user does not care, prefer the auto-derived project. Ask once. ' +
      'Note: if you choose action="skip" and the tool returns applied=false with a ' +
      'wouldDelete count, the session already has stored memory — relay that count to the ' +
      'user and, only if they confirm the deletion, call set_session_project again with ' +
      'action="skip" and confirmDelete=true.',
  );
  return lines.join('\n');
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

  // Picker: only when we have a session id to key the decision on AND no binding
  // already records a choice (idempotent on resume / re-injection).
  if (payload.sessionId && facts.hasBinding === false) {
    const picker = renderPicker(payload.sessionId, payload.cwd, facts.projects ?? []);
    if (picker) blocks.push(picker);
  }

  return buildContextOutput('SessionStart', blocks.join('\n\n')) ?? undefined;
}
