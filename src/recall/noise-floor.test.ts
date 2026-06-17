import { afterEach, describe, expect, it } from 'vitest';
import {
  cosineFromL2Distance,
  noiseFloorConfig,
  passesNoiseFloor,
  queryTokenCoverage,
} from './noise-floor.js';

const ENV = ['ABS_RECALL_MIN_COVERAGE', 'ABS_RECALL_MIN_COSINE'];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

describe('queryTokenCoverage (#144)', () => {
  it('is the fraction of distinct query content-tokens present in the hit (exact tokens)', () => {
    expect(queryTokenCoverage('coupa oauth migration', 'the coupa oauth migration is done')).toBe(
      1,
    );
    // Exact-token (no stemming) — mirrors recall's FTS leg, which also matches exact tokens.
    expect(queryTokenCoverage('coupa oauth migration', 'we migrated coupa to oauth')).toBeCloseTo(
      2 / 3,
      5,
    );
    expect(queryTokenCoverage('coupa oauth migration', 'coupa invoice export')).toBeCloseTo(
      1 / 3,
      5,
    );
  });
  it('ignores tokens shorter than 2 chars + is case-insensitive (mirrors toFtsQuery)', () => {
    expect(queryTokenCoverage('A Coupa', 'the COUPA system')).toBe(1); // "A" dropped, coupa matches
  });
  it('returns 1 for a query with no content tokens (nothing to floor on)', () => {
    expect(queryTokenCoverage('!! ?', 'anything')).toBe(1);
  });
  it('off-topic 1-of-many overlap scores low (the noise signature)', () => {
    // Mirrors the spike: off-topic queries matched exactly one (common) token.
    expect(queryTokenCoverage('sourdough bread fermentation hydration', 'bread recipe')).toBe(0.25);
  });
});

describe('cosineFromL2Distance (#144)', () => {
  it('maps unit-vector L2 distance to cosine (0→1, √2→0, 2→-1)', () => {
    expect(cosineFromL2Distance(0)).toBe(1);
    expect(cosineFromL2Distance(Math.SQRT2)).toBeCloseTo(0, 6);
    expect(cosineFromL2Distance(2)).toBe(-1);
  });
});

describe('passesNoiseFloor (#144)', () => {
  it('passes on strong lexical coverage alone', () => {
    expect(passesNoiseFloor('coupa oauth migration', 'coupa oauth migration done', undefined)).toBe(
      true,
    );
  });
  it('passes a semantic paraphrase on cosine even when coverage is low', () => {
    // Low literal overlap (1/3) but a strong vector match → kept (paraphrase safety).
    expect(passesNoiseFloor('squash several commits', 'git rebase interactive', 0.7)).toBe(true);
  });
  it('fails when coverage is low AND cosine is weak/absent (the junk case)', () => {
    expect(passesNoiseFloor('sourdough bread fermentation', 'bread', 0.05)).toBe(false);
    expect(passesNoiseFloor('sourdough bread fermentation', 'bread', undefined)).toBe(false);
  });
  it('is disabled when both thresholds are 0 (everything passes)', () => {
    process.env.ABS_RECALL_MIN_COVERAGE = '0';
    process.env.ABS_RECALL_MIN_COSINE = '0';
    expect(passesNoiseFloor('a b c d', 'only a', 0.0)).toBe(true);
  });
});

describe('noiseFloorConfig (#144)', () => {
  it('defaults to coverage 0.4 / cosine 0.45', () => {
    expect(noiseFloorConfig()).toEqual({ minCoverage: 0.4, minCosine: 0.45 });
  });
  it('honors env overrides', () => {
    process.env.ABS_RECALL_MIN_COVERAGE = '0.6';
    process.env.ABS_RECALL_MIN_COSINE = '0';
    expect(noiseFloorConfig()).toEqual({ minCoverage: 0.6, minCosine: 0 });
  });
  it('falls back to the default on a malformed/negative override (never silently disables)', () => {
    process.env.ABS_RECALL_MIN_COVERAGE = 'garbage';
    process.env.ABS_RECALL_MIN_COSINE = '-1';
    expect(noiseFloorConfig()).toEqual({ minCoverage: 0.4, minCosine: 0.45 });
  });
});
