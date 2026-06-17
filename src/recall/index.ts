export { annotateFreshness, freshnessTag } from './freshness.js';
export {
  cosineFromL2Distance,
  noiseFloorConfig,
  passesNoiseFloor,
  queryTokenCoverage,
} from './noise-floor.js';
export type { RecallFtsOptions, RecallHit, RecallOptions } from './recall.js';
export { Recall, toFtsQuery } from './recall.js';
export type { FusedHit, RankedList } from './rrf.js';
export { DEFAULT_RRF_K, reciprocalRankFusion } from './rrf.js';
export type { RecallScope, RecallScopeInput } from './scope.js';
export { resolveRecallProject } from './scope.js';
