/** Public surface of the ground-truth port (the verifiable-memory substrate). */

export { refreshIndex } from '../index/indexer.js';
export { createGroundTruthProvider } from './factory.js';
export { NullGroundTruthProvider } from './null-provider.js';
export type { GroundTruthProvider, ResolvedSymbol } from './types.js';
