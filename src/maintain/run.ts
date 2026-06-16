/**
 * Auto-distill cadence runner (#138). The non-interactive command both `abs maintain
 * --auto` (CLI) and the SessionEnd detached spawn drive — it composes the existing
 * shared cores end to end behind a dedicated cadence lock:
 *
 *   acquire `.cadence.lock` → consolidate (newest unconsolidated session) →
 *   generateOptimizations (heuristic + LLM judge) → auto-apply auto-memory ONLY
 *   (CLAUDE.md decisions stay manual) → advance the kind/project cursors per the §4
 *   keep-set partition → record token observability.
 *
 * Scope is deliberate (SPEC §1): consolidate → auto-memory only. CLAUDE.md is
 * git-tracked and stays gated/manual; skipped decisions keep nagging via their own
 * un-advanced cursor. No new write path into the index — `consolidate` writes lessons
 * through `memory.indexer.write` and `applyApprovedCandidate` mutates the auto-memory
 * file + `MEMORY.md` through the gated applier; the runner adds no writes of its own
 * beyond the kv_meta cursors + observability rollup.
 *
 * Invariants inherited unchanged (ADR-0004): idempotent (consolidate skips an already
 * consolidated session), append-only, write-nothing-on-error (consolidate W1 rollback;
 * gated applier backup/rollback), fail-open at the CLI.
 */
import { type AppConfig, loadConfig } from '../config.js';
import type { ConsolidateOptions, ConsolidateResult } from '../consolidate/index.js';
import { consolidate as consolidateCore } from '../consolidate/index.js';
import { optimizeCursorKey } from '../hooks/staleness.js';
import { defaultClaudeProjectsDir } from '../ingest/index.js';
import { createLlmProvider } from '../llm/index.js';
import type { Memory } from '../memory.js';
import {
  type ApplyOptions,
  type ApplyResult,
  advanceOptimizeCursorsAfterApply,
  applyApprovedCandidate as applyCore,
  type GenerateCandidatesOptions,
  type GenerateCandidatesResult,
  generateOptimizations as generateCore,
  type OptimizeCandidate,
  projectSlug,
} from '../optimize/index.js';
import { acquireCadenceLock, CADENCE_HEARTBEAT_MS, type CadenceLock } from '../store/index.js';

/** kv_meta key: total number of auto-distill cadence runs (observability rollup, P4). */
export const AUTO_DISTILL_RUNS = 'autoDistill:runs';
/** kv_meta key: cumulative LLM tokens spent by auto-distill (consolidate + generate). */
export const AUTO_DISTILL_TOKENS = 'autoDistill:tokens';
/** kv_meta key: ISO timestamp of the last auto-distill run. */
export const AUTO_DISTILL_LAST_RUN_AT = 'autoDistill:lastRunAt';

/** Why a cadence run produced no work without being an error (caller exits 0). */
export type MaintainSkip = 'locked' | 'no-llm';

/** The outcome of one `runMaintainAuto` pass. */
export interface MaintainResult {
  /** Set when the run was a benign no-op (another cadence held the lock, or no LLM). */
  skipped?: MaintainSkip;
  /** Lessons consolidate wrote this run (0 on skip/idempotent no-op). */
  consolidated: number;
  /** Auto-memory candidates successfully applied this run. */
  promoted: number;
  /** CLAUDE.md (decision) candidates SKIPPED — left for a manual `abs optimize`. */
  pendingDecisions: number;
  /** True when at least one kind/project cursor advanced this run. */
  cursorsAdvanced: boolean;
  /** LLM tokens this run spent (consolidate + generate, prompt + completion). */
  tokens: number;
}

/**
 * Injectable seams for deterministic unit tests (mirrors `SessionEndDeps`). Each
 * defaults to the real core; tests substitute fakes so no real LLM/lock is touched.
 */
export interface MaintainDeps {
  consolidate?: (memory: Memory, options: ConsolidateOptions) => Promise<ConsolidateResult>;
  generate?: (
    memory: Memory,
    config: AppConfig,
    options: GenerateCandidatesOptions,
  ) => Promise<GenerateCandidatesResult>;
  apply?: (
    memory: Memory,
    candidate: OptimizeCandidate,
    options: ApplyOptions,
  ) => Promise<ApplyResult>;
  acquireLock?: (dbPath: string) => CadenceLock;
  now?: () => Date;
}

/** Sum prompt + completion tokens from a core's optional usage block. */
function sumTokens(usage?: { promptTokens?: number; completionTokens?: number }): number {
  return (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
}

/**
 * Run ONE auto-distill cadence pass. Behind the dedicated cadence lock: a held lock
 * (another cadence running) → `{ skipped: 'locked' }` with ZERO LLM spend and no
 * advance; no `config.llm` → `{ skipped: 'no-llm' }`. Otherwise consolidate → generate
 * → auto-apply auto-memory-only → advance cursors → roll up observability. Never
 * throws into the caller for a benign skip; a core error propagates (the CLI fail-opens).
 */
export async function runMaintainAuto(
  memory: Memory,
  config: AppConfig = loadConfig(),
  deps: MaintainDeps = {},
): Promise<MaintainResult> {
  const empty: MaintainResult = {
    consolidated: 0,
    promoted: 0,
    pendingDecisions: 0,
    cursorsAdvanced: false,
    tokens: 0,
  };

  // (1) Cadence lock first (C3/W1). A held lock → no-op, zero LLM, no advance.
  const acquire = deps.acquireLock ?? acquireCadenceLock;
  const lock = acquire(config.dbPath);
  if (!lock.acquired) return { ...empty, skipped: 'locked' };

  const beat = setInterval(() => lock.heartbeat(), CADENCE_HEARTBEAT_MS);
  // The heartbeat interval must never keep the detached process (or the test runner)
  // alive on its own — the run drives liveness, not the timer.
  if (typeof beat.unref === 'function') beat.unref();

  try {
    // (2) No-LLM gate — consolidate cannot run without a provider.
    if (!config.llm) return { ...empty, skipped: 'no-llm' };

    const consolidate = deps.consolidate ?? defaultConsolidate(config);
    const generate = deps.generate ?? generateCore;
    const apply = deps.apply ?? applyCore;
    const projectRoot = process.cwd();
    const slug = projectSlug(projectRoot);

    // (3) Consolidate the newest unconsolidated session (idempotent skip = fine no-op).
    const pricePer1k = config.llm.pricePer1k;
    const consolidation = await consolidate(memory, {
      ...(pricePer1k !== undefined ? { pricePer1k } : {}),
    });
    let tokens = sumTokens(consolidation.estimate.usage);

    // (4) Generate candidates; capture the un-sliced keep-set the cursor advance needs.
    const { candidates, estimate, survivingIds } = await generate(memory, config, { projectRoot });
    tokens += sumTokens(estimate.usage);

    // (5) Auto-apply auto-memory ONLY. CLAUDE.md (decisions) stay manual — count + log.
    const applyOptions: ApplyOptions = { projectRoot, projectsDir: defaultClaudeProjectsDir() };
    const appliedIds = new Set<string>();
    let promoted = 0;
    let pendingDecisions = 0;
    for (const candidate of candidates) {
      if (candidate.target.kind !== 'auto-memory') {
        pendingDecisions += 1;
        continue;
      }
      const result = await apply(memory, candidate, applyOptions);
      if (result.applied) {
        appliedIds.add(candidate.id);
        promoted += 1;
      }
    }
    if (pendingDecisions > 0) {
      process.stderr.write(
        `[abs] ${pendingDecisions} decision(s) pending manual \`abs optimize\`\n`,
      );
    }

    // (6) Advance the kind/project cursors per the §4 keep-set partition. Lessons
    // (promoted-or-curated-out) advance; skipped decisions stay pending → no advance.
    const before = {
      lesson: memory.store.getMeta(optimizeCursorKey('lesson', slug)),
      decision: memory.store.getMeta(optimizeCursorKey('decision', slug)),
    };
    advanceOptimizeCursorsAfterApply(memory, slug, new Set(survivingIds), candidates, appliedIds);
    const cursorsAdvanced =
      memory.store.getMeta(optimizeCursorKey('lesson', slug)) !== before.lesson ||
      memory.store.getMeta(optimizeCursorKey('decision', slug)) !== before.decision;

    // (7) Observability rollup (P4) — auditable spend, never a silent surprise.
    // Atomic UPSERT increments (#138 RC-004): a JS read-modify-write would lose an
    // update if a stale-steal ever ran two cadences at once; `incrMeta` is immune.
    const now = (deps.now ?? (() => new Date()))();
    memory.store.incrMeta(AUTO_DISTILL_RUNS, 1);
    memory.store.incrMeta(AUTO_DISTILL_TOKENS, tokens);
    memory.store.setMeta(AUTO_DISTILL_LAST_RUN_AT, now.toISOString());

    return {
      consolidated: consolidation.written,
      promoted,
      pendingDecisions,
      cursorsAdvanced,
      tokens,
    };
  } finally {
    clearInterval(beat);
    lock.release();
  }
}

/** Build the real consolidate seam (provider built once from config). */
function defaultConsolidate(
  config: AppConfig,
): (memory: Memory, options: ConsolidateOptions) => Promise<ConsolidateResult> {
  // config.llm is guaranteed present here (the no-LLM gate already returned).
  const llm = createLlmProvider(config.llm as NonNullable<AppConfig['llm']>);
  return (memory, options) => consolidateCore(memory, llm, options);
}
