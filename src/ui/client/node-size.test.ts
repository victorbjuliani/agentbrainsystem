import { describe, expect, it } from 'vitest';
import { radiusFor } from './node-size.js';

describe('radiusFor', () => {
  it('returns the bare base for every type at sizeDriver 0', () => {
    expect(radiusFor('session', 0)).toBe(5);
    expect(radiusFor('user', 0)).toBe(2.6);
    expect(radiusFor('assistant', 0)).toBe(2.6);
    expect(radiusFor('tool', 0)).toBe(2.6);
    expect(radiusFor('lesson', 0)).toBe(8);
    expect(radiusFor('decision', 0)).toBe(8);
  });

  it('sizes consolidated nodes (lesson/decision) médio→grande regardless of degree', () => {
    // The load-bearing §11 guarantee: a degree-0 lesson clears the typical leaf.
    expect(radiusFor('lesson', 0)).toBeGreaterThan(radiusFor('tool', 3));
    expect(radiusFor('decision', 0)).toBeGreaterThan(radiusFor('user', 3));
  });

  it('keeps the documented degree-6 crossover (high-degree leaf may match a hub)', () => {
    // Intentional: a leaf at degree ≥6 is a legitimate hub; below 6 it stays smaller.
    expect(radiusFor('user', 5)).toBeLessThan(radiusFor('lesson', 0));
    expect(radiusFor('user', 6)).toBeGreaterThan(radiusFor('lesson', 0));
  });

  it('keeps session as the visual hub and grows monotonically with obs count', () => {
    expect(radiusFor('session', 20)).toBeGreaterThan(radiusFor('lesson', 10));
    expect(radiusFor('session', 50)).toBeGreaterThan(radiusFor('session', 5));
  });

  it('gives leaves a wider degree spread than before (well-connected reads as a star)', () => {
    expect(radiusFor('user', 9)).toBeGreaterThan(radiusFor('user', 1));
  });

  it('clamps non-finite and negative drivers to the base (never NaN)', () => {
    expect(radiusFor('user', Number.NaN)).toBe(2.6);
    expect(radiusFor('user', -3)).toBe(2.6);
    expect(radiusFor('user', Number.POSITIVE_INFINITY)).toBe(2.6);
  });

  it('is deterministic (no random leakage — main.ts and the renderer must agree)', () => {
    expect(radiusFor('session', 12)).toBe(radiusFor('session', 12));
  });
});
