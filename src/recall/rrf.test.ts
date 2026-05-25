import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion, toFtsQuery } from './index.js';

describe('reciprocalRankFusion', () => {
  it('ranks an id present in both lists above one present in only one', () => {
    const fused = reciprocalRankFusion([
      { name: 'vector', ids: [10, 20, 30] },
      { name: 'fts', ids: [20, 40] },
    ]);
    expect(fused[0]?.id).toBe(20); // in both → highest summed score
    expect(fused[0]?.ranks).toEqual({ vector: 2, fts: 1 });
  });

  it('rewards a better rank within a single list', () => {
    const fused = reciprocalRankFusion([{ name: 'vector', ids: [1, 2, 3] }]);
    expect(fused.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(fused[0]?.score).toBeGreaterThan(fused[1]?.score ?? 0);
  });

  it('handles empty lists', () => {
    expect(reciprocalRankFusion([{ name: 'vector', ids: [] }])).toEqual([]);
  });
});

describe('toFtsQuery', () => {
  it('tokenizes into quoted OR terms, lowercasing and dropping duplicates', () => {
    // "git" appears twice → deduped; punctuation dropped; order preserved
    expect(toFtsQuery('Squash my GIT commits, git!')).toBe(
      '"squash" OR "my" OR "git" OR "commits"',
    );
  });

  it('drops tokens shorter than 2 chars', () => {
    expect(toFtsQuery('a big queue x')).toBe('"big" OR "queue"');
  });

  it('returns null when nothing searchable', () => {
    expect(toFtsQuery('  ?! - ')).toBeNull();
  });

  it('does not let FTS operators leak through (quotes terms)', () => {
    // "OR" as a bare token would be an operator; quoting neutralizes it
    expect(toFtsQuery('cat OR dog')).toBe('"cat" OR "or" OR "dog"');
  });

  it('default (no opts) stays EXACT — recall semantics are unchanged (#129)', () => {
    expect(toFtsQuery('migration')).toBe('"migration"');
  });

  it('prefix mode appends a trailing * so a stem matches word variants (#129)', () => {
    // UI search opts in: "migrat" should reach "migration"/"migrations".
    expect(toFtsQuery('migration', { prefix: true })).toBe('"migration"*');
    expect(toFtsQuery('a big queue', { prefix: true })).toBe('"big"* OR "queue"*');
  });

  it('stem mode expands a token to its word-family root (english is the default)', () => {
    // The original term is kept alongside the stem, both OR-ed.
    expect(toFtsQuery('running', { stem: true })).toBe('"running" OR "run"');
    expect(toFtsQuery('migrations', { stem: true, prefix: true })).toBe(
      '"migrations"* OR "migrat"*',
    );
  });

  it('stem mode covers Portuguese too (bilingual store)', () => {
    expect(toFtsQuery('migrações', { stem: true, prefix: true })).toBe(
      '"migrações"* OR "migraçõ"*',
    );
  });

  it('stem mode dedupes overlapping roots across query terms', () => {
    // "migration" and "migrations" both stem to "migrat" → one shared term.
    expect(toFtsQuery('migration migrations', { stem: true, prefix: true })).toBe(
      '"migration"* OR "migrat"* OR "migrations"*',
    );
  });

  it('stem mode is off by default — recall stays exact (#129)', () => {
    expect(toFtsQuery('running')).toBe('"running"');
  });
});
