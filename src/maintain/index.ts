/**
 * Auto-distill cadence public surface (#138).
 *
 * `runMaintainAuto` is the non-interactive runner both `abs maintain --auto` (CLI)
 * and the SessionEnd detached spawn drive. The `autoDistill:*` kv_meta keys are the
 * observability rollup (`memory_status` reads them in Phase 7).
 */
export {
  AUTO_DISTILL_LAST_RUN_AT,
  AUTO_DISTILL_RUNS,
  AUTO_DISTILL_TOKENS,
  type MaintainDeps,
  type MaintainResult,
  type MaintainSkip,
  runMaintainAuto,
} from './run.js';
