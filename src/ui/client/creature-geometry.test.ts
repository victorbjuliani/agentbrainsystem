import { describe, expect, it } from 'vitest';
import { beadParam, recencyNorm, tentacleAngle, tentacleLength } from './creature-geometry.js';

// Pure anatomy→data mapping for the creature renderer (DESIGN.md §11). No WebGL:
// these deterministic functions are the unit-testable substitute for the retired
// 2D force-graph geometry (node-size/occlusion). See ADR-0015.
describe('creature-geometry (pure, no WebGL)', () => {
  describe('beadParam — observation position along its session tentacle (0=bell, 1=tip)', () => {
    it('places a lone observation at the tentacle midpoint', () => {
      expect(beadParam(0, 1)).toBe(0.5);
    });

    it('spreads observations evenly from near the bell (0.05) to the tip (0.97)', () => {
      expect(beadParam(0, 5)).toBeCloseTo(0.05, 5);
      expect(beadParam(4, 5)).toBeCloseTo(0.97, 5);
      expect(beadParam(2, 5)).toBeCloseTo(0.51, 5); // 0.05 + 0.5*0.92
    });
  });

  describe('tentacleAngle — radial placement of a session tentacle around the bell', () => {
    it('offsets the first tentacle by the base rotation', () => {
      expect(tentacleAngle(0, 6)).toBeCloseTo(0.4, 5);
    });

    it('distributes tentacles evenly around the bell', () => {
      expect(tentacleAngle(3, 6)).toBeCloseTo(Math.PI + 0.4, 5);
    });
  });

  describe('tentacleLength — fuller sessions hang lower, capped to stay on-screen', () => {
    it('is the base length for an empty session', () => {
      expect(tentacleLength(0)).toBeCloseTo(3.8, 5);
    });

    it('grows (log2) with observation count', () => {
      expect(tentacleLength(1)).toBeCloseTo(4.85, 5); // 3.8 + log2(2)*1.05
    });

    it('caps so a huge session never runs off-screen', () => {
      expect(tentacleLength(100000)).toBeCloseTo(8.0, 5); // 3.8 + 4.2 cap
    });
  });

  describe('recencyNorm — 0=oldest, 1=most recent (drives bead glow/position)', () => {
    it('maps a timestamp to its position in the window', () => {
      expect(recencyNorm(50, 0, 100)).toBeCloseTo(0.5, 5);
      expect(recencyNorm(0, 0, 100)).toBe(0);
      expect(recencyNorm(100, 0, 100)).toBe(1);
    });

    it('treats a degenerate window (all observations same time) as fresh', () => {
      expect(recencyNorm(5, 5, 5)).toBe(1);
    });

    it('clamps timestamps outside the window', () => {
      expect(recencyNorm(-10, 0, 100)).toBe(0);
      expect(recencyNorm(150, 0, 100)).toBe(1);
    });
  });
});
