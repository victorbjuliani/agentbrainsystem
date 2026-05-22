import { describe, expect, it } from 'vitest';
import { scopeToQuery } from './scope.js';
import type { ScopeState } from './types.js';

const base: ScopeState = { mode: 'topN', similarity: false };

describe('scopeToQuery', () => {
  it('topN scope requests the store-wide window (cap is internal, never exposed)', () => {
    expect(scopeToQuery({ ...base, mode: 'topN' })).toBe('/api/graph?topN=200');
  });

  it('appends the similarity flag when enabled', () => {
    expect(scopeToQuery({ ...base, mode: 'topN', similarity: true })).toBe(
      '/api/graph?topN=200&similarity=1',
    );
  });

  it('scopes topN to a project when one is selected', () => {
    expect(scopeToQuery({ ...base, mode: 'topN', project: 'demo' })).toBe(
      '/api/graph?topN=200&project=demo',
    );
  });

  it('session mode with a focused session asks for that session', () => {
    expect(scopeToQuery({ mode: 'session', similarity: false, sessionId: 7 })).toBe(
      '/api/graph?session=7',
    );
  });

  it('session mode with no focus sends a param-less request (server default)', () => {
    expect(scopeToQuery({ mode: 'session', similarity: false })).toBe('/api/graph');
  });

  it('search supersedes the topN/session scope (store-wide FTS)', () => {
    expect(scopeToQuery({ mode: 'topN', similarity: true, sessionId: 9, search: 'worktree' })).toBe(
      '/api/graph?search=worktree&similarity=1',
    );
  });
});
