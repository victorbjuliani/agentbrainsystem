/**
 * UI module public surface (issue #11) — the read-only memory-graph viewer.
 *
 * `buildGraph` is the pure store→wire projection; `createUiServer` / `startUiServer`
 * are the localhost HTTP layer. The graph contract types are re-exported so the
 * client (compiled separately under tsconfig.ui.json) shares one source of truth.
 */
export { buildGraph } from './graph.js';
export * from './graph-types.js';
export { createUiServer, startUiServer } from './server.js';
