// @vitest-environment jsdom
/**
 * The WebGL2 fallback (ADR-0015): on a context-less browser `createRenderer` must
 * throw `CreatureUnsupportedError` so `main.ts` can paint the on-brand banner
 * instead of a dead black canvas (main.ts catches exactly this).
 *
 * jsdom has no WebGL2 — `canvas.getContext('webgl2')` returns null — so this
 * exercises the real `webgl2Supported()` probe and the guard at the top of
 * `createRenderer`, the runtime path the e2e suite can't reach (it never injects a
 * pre-load WebGL2 stub, and Chromium always has WebGL2 via SwiftShader).
 *
 * Loaded with a dynamic import AFTER stubbing `window.matchMedia`: creature.ts
 * reads `prefers-reduced-motion` at module top level, and jsdom omits matchMedia.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

let createRenderer: typeof import('./creature.js').createRenderer;
let CreatureUnsupportedError: typeof import('./creature.js').CreatureUnsupportedError;

beforeAll(async () => {
  // creature.ts touches window.matchMedia at import time; jsdom doesn't implement it.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  // jsdom has no canvas backend: make getContext return null explicitly (the
  // "no WebGL2" condition) instead of letting jsdom log a noisy "Not implemented".
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const mod = await import('./creature.js');
  createRenderer = mod.createRenderer;
  CreatureUnsupportedError = mod.CreatureUnsupportedError;
});

describe('createRenderer — WebGL2 fallback', () => {
  it('throws CreatureUnsupportedError when the browser has no WebGL2 context', () => {
    const mount = document.createElement('div');
    expect(() => createRenderer(mount, { onSelect() {} })).toThrow(CreatureUnsupportedError);
  });

  it('leaves no dead canvas on the mount when it bails', () => {
    // The guard runs before any canvas is appended, so a context-less browser never
    // gets a black rectangle it can't paint into.
    const mount = document.createElement('div');
    try {
      createRenderer(mount, { onSelect() {} });
    } catch {
      // expected — asserted above
    }
    expect(mount.querySelector('canvas')).toBeNull();
  });
});
