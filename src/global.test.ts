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
