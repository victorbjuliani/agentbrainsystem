import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { type Memory, openMemory } from '../memory.js';

let dir: string;

function config(): AppConfig {
  return {
    dataDir: dir,
    dbPath: join(dir, 'memory.db'),
    embedding: { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384 },
  };
}

const CORPUS: Array<{ kind: string; content: string }> = [
  { kind: 'note', content: 'The capital of France is Paris and it sits on the Seine.' },
  {
    kind: 'note',
    content: 'Python list comprehensions build lists from an iterable in one expression.',
  },
  { kind: 'note', content: 'Docker Compose sets up networking between multiple containers.' },
  { kind: 'lesson', content: 'Use git rebase --interactive to squash several commits into one.' },
  { kind: 'note', content: 'SQLite WAL mode keeps writes durable across process restarts.' },
];

async function seed(mem: Memory): Promise<void> {
  const sessionId = mem.store.createSession({ externalId: 's1' });
  for (const obs of CORPUS) {
    await mem.indexer.write({ sessionId, kind: obs.kind, content: obs.content });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-recall-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Recall — semantic acceptance', () => {
  it('returns a saved item in the top-3 for a semantic query', async () => {
    const mem = await openMemory(config());
    await seed(mem);

    const hits = await mem.recall.recall('how do I squash commits in version control', {
      limit: 3,
    });
    const contents = hits.map((h) => h.observation.content);
    expect(contents.some((c) => c.includes('git rebase'))).toBe(true);
    mem.close();
  });

  it('matches on keyword overlap even when phrasing differs', async () => {
    const mem = await openMemory(config());
    await seed(mem);
    const hits = await mem.recall.recall('Paris France capital', { limit: 3 });
    expect(hits[0]?.observation.content).toContain('Paris');
    mem.close();
  });
});

describe('Recall — restart survival acceptance', () => {
  it('returns identical recall before and after a daemon restart', async () => {
    const cfg = config();

    // session 1: seed + recall
    const mem1 = await openMemory(cfg);
    await seed(mem1);
    const before = await mem1.recall.recall('durable storage that survives restart', { limit: 5 });
    mem1.close();

    // session 2: reopen the SAME db, recall the SAME query
    const mem2 = await openMemory(cfg);
    expect(mem2.ensure?.rebuilt).toBe(false); // index persisted, no rebuild needed
    const after = await mem2.recall.recall('durable storage that survives restart', { limit: 5 });
    mem2.close();

    expect(after.map((h) => h.observation.id)).toEqual(before.map((h) => h.observation.id));
    expect(after.map((h) => Number(h.score.toFixed(6)))).toEqual(
      before.map((h) => Number(h.score.toFixed(6))),
    );
  });
});
