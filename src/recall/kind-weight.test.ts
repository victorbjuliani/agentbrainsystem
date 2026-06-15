import { describe, expect, it } from 'vitest';
import { DURABLE_KIND_WEIGHT, kindWeight } from './kind-weight.js';

describe('kindWeight (#141)', () => {
  it('weights curated/durable kinds at DURABLE_KIND_WEIGHT', () => {
    for (const kind of ['decision', 'lesson', 'note']) {
      expect(kindWeight(kind)).toBe(DURABLE_KIND_WEIGHT);
    }
  });

  it('weights raw ingest kinds at the 1.0 baseline', () => {
    for (const kind of ['user', 'assistant', 'tool', 'tool_edit', 'main', 'unknown']) {
      expect(kindWeight(kind)).toBe(1);
    }
  });

  it('durable weight is strictly above the baseline (a boost, not a filter)', () => {
    expect(DURABLE_KIND_WEIGHT).toBeGreaterThan(1);
  });
});
