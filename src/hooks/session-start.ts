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
import { loadConfig } from '../config.js';
import { readBinding } from '../ingest/index.js';
import { openMemory } from '../memory.js';
import { resolveRecallProject } from '../recall/index.js';
import { EMBED_DEGRADED_KEY, REBUILD_FAILED_KEY } from '../store/index.js';
import { buildContextOutput, type HookPayload } from './payload.js';
import { evaluateTwoSignalStaleness, optimizeCursorKey, parseCursor } from './staleness.js';

export interface SessionStartFacts {
  sessions: number;
  observations: number;
  /** Raw turns whose session has no consolidate row (anti-join, #138). */
  rawPending: number;
  /** Distinct sessions needing consolidate (#138). */
  rawSessions: number;
  /** rawPending >= threshold (#138). */
  rawFlagged: boolean;
  /** Consolidate lessons above the lesson cursor, this project (#138/#148). */
  lessonsPending: number;
  /** Consolidate decisions above the decision cursor, this project (#138/#148). */
  decisionsPending: number;
  /** lessons + decisions pending > 0 (#138/#148). */
  consolidatedFlagged: boolean;
  /** Whether an LLM is configured — drives auto-vs-manual copy (#138). */
  hasLlm: boolean;
  /** Whether a session→project binding already exists for this session (#52). */
  hasBinding?: boolean;
  /** Index is stale / a prior rebuild left it degraded — recall is unreliable (#101). */
  indexStale?: boolean;
}

export interface SessionStartDeps {
  /** Injection seam for tests — defaults to reading the real store read-only. */
  gatherFacts?: () => Promise<SessionStartFacts>;
}

/**
 * Read store stats + the two-signal staleness (+ picker facts) without mutating or
 * loading any model. One `ensure:false` open serves both blocks. The optimize signals
 * are PROJECT-scoped via the session's resolved slug — the same label recall uses —
 * so the banner never counts another project's pending obs (#138/#148/W1).
 */
async function gatherFactsFromStore(payload: HookPayload): Promise<SessionStartFacts> {
  const memory = await openMemory(undefined, { ensure: false });
  try {
    const counts = memory.store.counts();
    // Signal 1 — needs consolidate: a session-level anti-join (store-wide), not a
    // cursor. Strands nothing below an already-consolidated session's id (Gate 0b C1).
    const rawPending = memory.store.countUnconsolidatedRawTurns();
    const rawSessions = memory.store.countUnconsolidatedSessions();
    // Signal 2 — needs optimize: two kind+project cursors. Resolve the project slug
    // the same way recall does (stored label first, cwd slug last); undefined → ''
    // which matches zero consolidate rows (degrade to "nothing pending" for the
    // optimize signal only — the raw anti-join above is unaffected).
    const slug =
      resolveRecallProject(memory.store, {
        scope: 'project',
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
        ...(payload.transcriptPath ? { transcriptPath: payload.transcriptPath } : {}),
        ...(payload.cwd ? { cwd: payload.cwd } : {}),
      }) ?? '';
    const lessonsPending = memory.store.countConsolidatedSince(
      slug,
      'lesson',
      parseCursor(memory.store.getMeta(optimizeCursorKey('lesson', slug))),
    );
    const decisionsPending = memory.store.countConsolidatedSince(
      slug,
      'decision',
      parseCursor(memory.store.getMeta(optimizeCursorKey('decision', slug))),
    );
    const verdict = evaluateTwoSignalStaleness({
      rawPending,
      rawSessions,
      lessonsPending,
      decisionsPending,
      hasLlm: loadConfig().llm !== undefined,
    });
    const facts: SessionStartFacts = {
      sessions: counts.sessions,
      observations: counts.observations,
      rawPending: verdict.rawPending,
      rawSessions: verdict.rawSessions,
      rawFlagged: verdict.rawFlagged,
      lessonsPending: verdict.lessonsPending,
      decisionsPending: verdict.decisionsPending,
      consolidatedFlagged: verdict.consolidatedFlagged,
      hasLlm: verdict.hasLlm,
      // status() is read-only (no rebuild — ensure:false above); it reports the
      // staleness verdict that is otherwise computed but never surfaced (#101).
      // A background rebuild that FAILED (#103) records a durable flag — treat that
      // as degraded too, since its drift may have been partially repaired yet the
      // index is not trustworthy. A hook-path embed that timed out on the first-run
      // model download (#111) likewise leaves the index behind until the model caches.
      indexStale:
        memory.indexer.status().stale ||
        memory.store.getMeta(REBUILD_FAILED_KEY) !== null ||
        memory.store.getMeta(EMBED_DEGRADED_KEY) !== null,
    };
    if (payload.sessionId) {
      facts.hasBinding = readBinding(memory.store, payload.sessionId) !== null;
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
  // Signal 1 — needs consolidate (raw turns not yet distilled). With an LLM the
  // auto-distill cadence handles it; without one, the user must act.
  if (facts.rawFlagged) {
    const head = `Staleness: ${facts.rawPending} turn(s) across ${facts.rawSessions} session(s) not yet distilled`;
    if (facts.hasLlm) {
      lines.push(`${head} — auto-distill handles this in the background when each session ends.`);
    } else {
      lines.push(
        `${head} — configure an LLM (ABS_LLM_BASE_URL) or run \`abs consolidate\` to distil them ` +
          'into durable lessons.',
      );
    }
  }
  // Signal 2 — needs optimize (durable lessons/decisions not yet promoted to files).
  // Lessons auto-clear under the cadence; decisions persist until a manual promote.
  if (facts.consolidatedFlagged) {
    lines.push(
      `Staleness: ${facts.lessonsPending} lesson(s) + ${facts.decisionsPending} decision(s) pending ` +
        'promotion — run `abs optimize` to write them into memory files.',
    );
  }
  if (facts.indexStale) {
    lines.push(
      'DEGRADED: the recall index is stale (a rebuild is pending or a prior one failed) — ' +
        'recall may miss memories until it is rebuilt. Run `abs doctor` to inspect.',
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
  const facts = deps.gatherFacts ? await deps.gatherFacts() : await gatherFactsFromStore(payload);

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
