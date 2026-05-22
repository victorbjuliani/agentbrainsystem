/**
 * `remember` MCP tool core (#). Tests the extracted `rememberAction` directly
 * (the registerTool closure is a thin wrapper). Uses a deterministic offline
 * provider so the test never loads the real embedding model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../embedding/index.js';
import { Indexer } from '../indexer/index.js';
import type { Memory } from '../memory.js';
import { Recall } from '../recall/index.js';
import { MemoryStore } from '../store/index.js';
import { rememberAction } from './server.js';

class FakeProvider implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-v1';
  readonly dimensions = 8;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(this.dimensions).fill(0) as number[];
      for (let i = 0; i < t.length; i++) v[i % this.dimensions] += t.charCodeAt(i);
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

describe('rememberAction (#)', () => {
  let dir: string;
  let memory: Memory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-mcp-remember-'));
    const store = new MemoryStore({ dbPath: join(dir, 'm.db'), dimensions: 8 }).open();
    const provider = new FakeProvider();
    const indexer = new Indexer(store, provider);
    const recall = new Recall(store, provider);
    memory = { store, provider, indexer, recall, close: () => store.close() };
  });

  afterEach(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('scope=global stores under the reserved global session', async () => {
    const r = await rememberAction(memory, { content: 'Prefer pnpm in all repos.', scope: 'global' });
    expect(r).toMatchObject({ scope: 'global' });
    const g = memory.store.getSessionByExternalId('__global__');
    const rows = memory.store.listObservations({ sessionId: g?.id });
    expect(rows.some((o) => o.content === 'Prefer pnpm in all repos.')).toBe(true);
  });

  it('defaults to project scope under the given/default session', async () => {
    const r = await rememberAction(memory, { content: 'local note', session: 's1' });
    expect(r).toMatchObject({ scope: 'project' });
    expect(memory.store.getSessionByExternalId('__global__')).toBeNull();
  });
});
