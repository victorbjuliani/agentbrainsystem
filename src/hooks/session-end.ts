/**
 * SessionEnd hook handler (#15, scoped in #62) — auto-ingest on session close, $0,
 * no LLM.
 *
 * When a Claude Code session ends, Claude Code runs this with the hook payload on
 * stdin. We ingest ONLY the just-finished session's transcript (`transcript_path`
 * from the payload) via `ingestSingleSession` — never a full-tree scan. This is the
 * #62 fix: a full scan re-ingested the machine's whole history whenever the store
 * was fresh/reset (its byte-cursors live in the same DB), silently back-filling
 * unrelated projects. Pulling historical transcripts is now an explicit `abs ingest`
 * action; the hook stays scoped to the current session. The default local embedding
 * provider indexes the lines ($0, offline); we NEVER call consolidate/LLM here (#12).
 *
 * SessionEnd cannot inject context, so this handler returns `undefined` (no stdout).
 * It runs behind `runHookSafely`, so any failure here is swallowed and the session
 * is never blocked (ADR-0004). We open memory with the default ensure gate so a
 * drifted index self-heals, then always close the store.
 */
import { sweepAnchors } from '../anchoring/index.js';
import { createGroundTruthProvider, type GroundTruthProvider } from '../ground-truth/index.js';
import { ingestSingleSession } from '../ingest/index.js';
import { openMemory } from '../memory.js';
import type { HookPayload } from './payload.js';

/** Max claimed anchors a single SessionEnd promotes — bounds the out-of-hot-path cost. */
const SWEEP_LIMIT = 200;

export interface SessionEndDeps {
  /** Injection seam for tests — defaults to the real openMemory + ingest. */
  ingest?: (transcriptPath: string) => Promise<void>;
  /** Injection seam for tests — defaults to the cwd-rooted ground-truth provider. */
  groundTruth?: GroundTruthProvider;
}

/**
 * Ingest the current session's transcript. Resolves `undefined` (SessionEnd injects
 * nothing). A payload without `transcript_path` is a no-op — we deliberately do NOT
 * fall back to a full-tree scan (that is the historical back-fill #62 removes).
 * Throws on failure — the caller (`runHookSafely`) swallows it.
 */
export async function handleSessionEnd(
  payload: HookPayload,
  deps: SessionEndDeps = {},
): Promise<undefined> {
  const transcriptPath = payload.transcriptPath;
  if (!transcriptPath) return undefined; // nothing to scope to — never full-scan

  if (deps.ingest) {
    await deps.ingest(transcriptPath);
    return undefined;
  }
  const memory = await openMemory();
  try {
    await ingestSingleSession(memory, transcriptPath);

    // #26 integration: promote the just-seeded `claimed` anchors against ground truth,
    // OUT of the interactive hot path (this is exactly where sweep.ts intends to run).
    // Fail-open (ADR-0004): an unavailable provider (no .code-review-graph/graph.db) is a
    // clean no-op, preserving offline/$0; a sweep error never undoes a successful ingest.
    const provider = deps.groundTruth ?? createGroundTruthProvider(payload.cwd ?? process.cwd());
    try {
      sweepAnchors(memory.store, provider, { limit: SWEEP_LIMIT });
    } catch {
      // swallow — ingest already succeeded
    } finally {
      if (!deps.groundTruth) provider.close();
    }
  } finally {
    memory.close();
  }
  return undefined;
}
