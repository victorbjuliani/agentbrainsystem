/** Public surface of the ground-truth port (the verifiable-memory substrate). */

export { createGroundTruthProvider } from './factory.js';
export { CodeReviewGraphProvider } from './graph-provider.js';
export { NullGroundTruthProvider } from './null-provider.js';
export type { GroundTruthProvider, ResolvedSymbol } from './types.js';
