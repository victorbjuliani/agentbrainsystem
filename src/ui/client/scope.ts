/**
 * Pure scope → query projection (extracted from main.ts so it is testable without
 * the DOM/CSS-bound container). Builds the `/api/graph` query string from the
 * current `ScopeState`. The `topN=200` cap is an implementation detail kept here,
 * never surfaced in the UI chrome (the scope control reads "tudo", not "top 200").
 *
 * Precedence mirrors the backend (src/ui/graph.ts): an active search is store-wide
 * and authoritative, so it supersedes the topN/session scope; otherwise topN wins
 * over a focused session. The similarity flag is orthogonal and always appended.
 */
import type { ScopeState } from './types.js';

/** The hard topN window the client requests; the backend clamps to its own caps. */
const TOP_N = 200;

/** Build the `/api/graph` query string from the current scope. */
export function scopeToQuery(scope: ScopeState): string {
  const p = new URLSearchParams();
  if (scope.search) {
    // Search is store-wide and authoritative — it supersedes the topN/session
    // scope server-side, so we send only it (plus the similarity toggle).
    p.set('search', scope.search);
  } else if (scope.mode === 'topN') {
    p.set('topN', String(TOP_N));
    // Opt-in project filter scopes the topN window to one project (#62-B).
    if (scope.project) p.set('project', scope.project);
  } else if (scope.sessionId !== undefined) {
    p.set('session', String(scope.sessionId));
  }
  if (scope.similarity) p.set('similarity', '1');
  const qs = p.toString();
  return qs ? `/api/graph?${qs}` : '/api/graph';
}
