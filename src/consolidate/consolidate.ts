/**
 * Consolidation orchestrator — the I/O side of issue #12.
 *
 * Resolves a target session, reads its raw transcript, asks an injected
 * `LlmProvider` to distill it (so tests stub the LLM and never touch a network),
 * then writes the resulting lessons back as first-class observations THROUGH the
 * indexer so they are recallable (the embed → persist → recall invariant). Never
 * via `store.createObservation` directly.
 *
 * Safety properties:
 *   - opt-in & idempotent: a session already consolidated is skipped (no LLM call)
 *     unless `force`.
 *   - write-nothing-on-error (W1): if any write in the batch fails, every write
 *     made this run is rolled back before rethrowing — the store never holds a
 *     partial consolidation.
 *   - dry-run: makes the (single) LLM call to preview candidates + cost, writes
 *     nothing.
 */
import type { LlmProvider, LlmUsage } from '../llm/index.js';
import type { Memory } from '../memory.js';
import type { Observation, Session } from '../store/index.js';
import { buildPrompt, estimatePromptTokens, parseLessons } from './distill.js';
import type { ConsolidateOptions, ConsolidateResult, LessonCandidate } from './types.js';

/** The `source` tag every consolidation output carries. */
const CONSOLIDATE_SOURCE = 'consolidate';

/**
 * Cap on transcript turns fed to the LLM (SEC-01) — bounds prompt cost and memory
 * on a very large session. listObservations is id-ASC, so we keep the most recent
 * turns (where conclusions/decisions live).
 */
const MAX_TRANSCRIPT_OBSERVATIONS = 400;

/** A skip result (no LLM call, no writes) the caller surfaces as a benign exit 0. */
function skip(sessionId: number, reason: ConsolidateResult['skipped']): ConsolidateResult {
  return {
    sessionId,
    written: 0,
    dryRun: false,
    candidates: [],
    estimate: { promptCharEstimateTokens: 0 },
    skipped: reason,
  };
}

/** Prior consolidation output for a session (idempotency + force-replace target). */
function priorConsolidation(memory: Memory, sessionId: number): Observation[] {
  return memory.store.listObservationsBySourceSession(sessionId, { source: CONSOLIDATE_SOURCE });
}

/**
 * Resolve the session to consolidate. With an explicit id, validate it exists.
 * Otherwise pick the newest-active session that has no prior consolidation; return
 * `'none'` when there is none (caller skips with 'no-unconsolidated-session').
 */
function resolveSession(memory: Memory, options: ConsolidateOptions): Session | 'none' {
  if (options.sessionId !== undefined) {
    const session = memory.store.getSession(options.sessionId);
    if (!session) throw new Error(`session ${options.sessionId} not found`);
    return session;
  }
  for (const session of memory.store.listSessionsByActivity()) {
    if (priorConsolidation(memory, session.id).length === 0) return session;
  }
  return 'none';
}

export async function consolidate(
  memory: Memory,
  llm: LlmProvider,
  options: ConsolidateOptions = {},
): Promise<ConsolidateResult> {
  const resolved = resolveSession(memory, options);
  if (resolved === 'none') return skip(0, 'no-unconsolidated-session');
  const session = resolved;
  const sessionId = session.id;

  // Idempotency: a consolidated session is a no-op unless force (no LLM call).
  const prior = priorConsolidation(memory, sessionId);
  if (prior.length > 0 && !options.force) {
    return skip(sessionId, 'already-consolidated');
  }

  // Transcript = the session's observations minus prior consolidation output.
  // We filter by source (NOT kind) so a real kind:'decision' turn is preserved.
  const turns = memory.store
    .listObservations({ sessionId })
    .filter((o) => o.source !== CONSOLIDATE_SOURCE);
  if (turns.length === 0) return skip(sessionId, 'no-observations');
  // Bound the prompt (SEC-01): distil from at most the most recent N turns.
  const transcript =
    turns.length > MAX_TRANSCRIPT_OBSERVATIONS ? turns.slice(-MAX_TRANSCRIPT_OBSERVATIONS) : turns;

  // Distill (the single LLM call). A parse failure throws → caller treats as a
  // clean failure (no writes have happened yet).
  const messages = buildPrompt(session, transcript);
  const promptCharEstimateTokens = estimatePromptTokens(messages);
  const completion = await llm.complete(messages, { responseFormatJson: true });
  const candidates = parseLessons(completion.text);

  const estimate = buildEstimate(promptCharEstimateTokens, completion.usage, options.pricePer1k);

  if (options.dryRun) {
    return { sessionId, written: 0, dryRun: true, candidates, estimate };
  }

  // Real run. Write the NEW lessons first; only once they all persist do we drop
  // the prior set on --force. So a mid-write failure rolls back this run's writes
  // and leaves the prior consolidation intact — write-nothing-on-error, including
  // --force (never a zero/partial state).
  //
  // Content-hash idempotence (#105) makes this saga identity-aware: a new lesson
  // whose (session, content, source) matches a prior consolidation row REUSES that
  // row's id instead of creating a fresh one. We track which prior ids the writes
  // aliased and exclude them from BOTH the rollback (never delete a prior row we
  // only re-used) and the force-replace (a reused row IS one of the new lessons).
  const priorIds = new Set(prior.map((o) => o.id));
  const writtenIds: number[] = [];
  try {
    for (const candidate of candidates) {
      const id = await writeLesson(memory, sessionId, candidate);
      writtenIds.push(id);
    }
  } catch (err) {
    // W1 — roll back only rows this run genuinely CREATED. An aliased prior row was
    // not created here; deleting it would corrupt the intact prior set.
    for (const id of writtenIds) {
      if (!priorIds.has(id)) memory.store.deleteObservation(id);
    }
    throw err;
  }

  // All new lessons persisted — safe to replace the prior set (force). Delete only
  // the prior rows this run did NOT reuse (a reused row is now a new lesson).
  if (options.force) {
    const reused = new Set(writtenIds);
    for (const obs of prior) {
      if (!reused.has(obs.id)) memory.store.deleteObservation(obs.id);
    }
  }

  return { sessionId, written: candidates.length, dryRun: false, candidates, estimate };
}

/** Write one lesson through the indexer (index-at-write → recallable). */
function writeLesson(
  memory: Memory,
  sessionId: number,
  candidate: LessonCandidate,
): Promise<number> {
  return memory.indexer.write({
    sessionId,
    kind: candidate.kind,
    content: candidate.content,
    source: CONSOLIDATE_SOURCE,
    metadata: { sourceSession: sessionId, consolidatedAt: new Date().toISOString() },
  });
}

/** Assemble the estimate block, computing cost only when price + usage are present. */
function buildEstimate(
  promptCharEstimateTokens: number,
  usage: LlmUsage | undefined,
  pricePer1k: number | undefined,
): ConsolidateResult['estimate'] {
  const estimate: ConsolidateResult['estimate'] = { promptCharEstimateTokens };
  if (usage) estimate.usage = usage;
  if (pricePer1k !== undefined && usage) {
    const total = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    estimate.costEstimate = (total / 1000) * pricePer1k;
  }
  return estimate;
}
