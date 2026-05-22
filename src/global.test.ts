import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_PROJECT, getOrCreateGlobalSession } from './global.js';
import { MemoryStore } from './store/index.js';

describe('global brain sentinel', () => {
  let dir: string;
  let store: MemoryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-global-'));
    store = new MemoryStore({ dbPath: join(dir, 'm.db'), dimensions: 8 }).open();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sentinel value is the literal hardcoded in the store SQL (listProjects/searchFts/knn)', () => {
    // The store SQL embeds '__global__' inline (it cannot import this const — that
    // would be a circular dep). This assertion ties the two together so a rename here
    // fails loudly instead of silently desyncing the recall/exclusion filters.
    expect(GLOBAL_PROJECT).toBe('__global__');
  });

  it('creates one reserved session keyed by the sentinel and reuses it', () => {
    const a = getOrCreateGlobalSession(store);
    const b = getOrCreateGlobalSession(store);
    expect(a).toBe(b);
    const s = store.getSessionByExternalId(GLOBAL_PROJECT);
    expect(s?.project).toBe(GLOBAL_PROJECT);
  });

  it('hides the sentinel from listProjects (not a selectable project)', () => {
    getOrCreateGlobalSession(store);
    store.createSession({ externalId: 'real', project: '-Users-me-Devs-foo' });
    expect(store.listProjects()).toEqual(['-Users-me-Devs-foo']);
  });
});
