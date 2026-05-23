// src/harness/registry.test.ts
import { describe, expect, it } from 'vitest';
import { createRegistry } from './registry.js';
import type { HarnessAdapter } from './types.js';

function fakeAdapter(id: string, installed: boolean): HarnessAdapter {
  return {
    id,
    displayName: id,
    detect: async () => installed,
    qualifies: () => ({ ok: true, missing: [] }),
    eventMap: { capture: [], recall: [], guard: [] },
    install: async () => ({ wired: [] }),
    uninstall: async () => ({ removed: [] }),
    registerMcp: async () => ({ status: 'already' }),
    resolveSession: () => null,
  };
}

describe('createRegistry', () => {
  it('resolves a registered adapter by id', () => {
    const reg = createRegistry([fakeAdapter('a', true), fakeAdapter('b', false)]);
    expect(reg.byId('a')?.id).toBe('a');
    expect(reg.byId('missing')).toBeUndefined();
  });

  it('lists only installed adapters via detectInstalled', async () => {
    const reg = createRegistry([fakeAdapter('a', true), fakeAdapter('b', false)]);
    const installed = await reg.detectInstalled();
    expect(installed.map((x) => x.id)).toEqual(['a']);
  });
});
