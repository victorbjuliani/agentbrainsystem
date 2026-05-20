import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../embedding/index.js';
import { Indexer } from '../indexer/index.js';
import type { Memory } from '../memory.js';
import { Recall } from '../recall/index.js';
import { MemoryStore } from '../store/index.js';
import { ingestClaudeProjects } from './ingest.js';

/** Deterministic, offline provider so ingestion tests run without a model download. */
class FakeProvider implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-v1';
  readonly dimensions = 8;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vec(t));
  }
  private vec(t: string): number[] {
    const v = new Array(this.dimensions).fill(0) as number[];
    for (let i = 0; i < t.length; i++) {
      v[i % this.dimensions] = (v[i % this.dimensions] ?? 0) + t.charCodeAt(i);
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}

let dir: string;
let projectsDir: string;

/** Build a Memory-shaped object wired to a temp store + the fake provider. */
function newMemory(): Memory {
  const store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: 8 }).open();
  const provider = new FakeProvider();
  const indexer = new Indexer(store, provider);
  const recall = new Recall(store, provider);
  return { store, provider, indexer, recall, close: () => store.close() };
}

/** A Claude Code transcript entry with a string `content` (user style). */
function userLine(sessionId: string, cwd: string, text: string, uuid: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    cwd,
    uuid,
    timestamp: '2026-05-20T10:00:00.000Z',
    message: { role: 'user', content: text },
  });
}

/** A Claude Code transcript entry with block-array `content` (assistant style). */
function assistantLine(
  sessionId: string,
  cwd: string,
  blocks: Array<Record<string, unknown>>,
  uuid: string,
): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    cwd,
    uuid,
    timestamp: '2026-05-20T10:01:00.000Z',
    message: { role: 'assistant', content: blocks },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-ingest-'));
  projectsDir = join(dir, 'projects');
  mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ingestClaudeProjects — first ingest', () => {
  it('creates observations and sessions from a fake projects tree', async () => {
    const projDir = join(projectsDir, '-Users-me-Devs-foo');
    mkdirSync(projDir, { recursive: true });
    const file = join(projDir, 'session.jsonl');
    writeFileSync(
      file,
      [
        userLine('sess-1', '/Users/me/Devs/foo', 'how do I run the tests', 'u1'),
        assistantLine(
          'sess-1',
          '/Users/me/Devs/foo',
          [
            { type: 'thinking', thinking: 'internal reasoning here', signature: 'sig' },
            { type: 'text', text: 'run npm test from the repo root' },
          ],
          'a1',
        ),
        '   ', // whitespace-only line -> skipped
        '{ not valid json', // malformed -> skipped
        assistantLine(
          'sess-1',
          '/Users/me/Devs/foo',
          [{ type: 'tool_use', name: 'Bash', input: {} }],
          'a2',
        ), // tool-only -> no extractable text, skipped
        '',
      ].join('\n'),
    );

    const memory = newMemory();
    const result = await ingestClaudeProjects(memory, { projectsDir });

    expect(result.filesProcessed).toBe(1);
    expect(result.observationsAdded).toBe(2);
    expect(result.observationsSkipped).toBe(3); // whitespace + malformed + tool-only

    const session = memory.store.getSessionByExternalId('sess-1');
    expect(session).not.toBeNull();
    expect(session?.project).toBe('-Users-me-Devs-foo');

    const obs = memory.store.listObservations({ sessionId: session?.id });
    expect(obs).toHaveLength(2);
    const user = obs.find((o) => o.kind === 'user');
    const asst = obs.find((o) => o.kind === 'assistant');
    expect(user?.content).toBe('how do I run the tests');
    expect(asst?.content).toBe('run npm test from the repo root');
    expect(user?.source).toBe(file);
    expect(user?.metadata).toMatchObject({ uuid: 'u1' });
    expect(user?.createdAt).toBe('2026-05-20T10:00:00.000Z');

    memory.close();
  });

  it('recall finds an ingested observation via knn', async () => {
    const projDir = join(projectsDir, '-Users-me-Devs-bar');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 's.jsonl'),
      userLine('sess-x', '/Users/me/Devs/bar', 'kangaroo elephant zebra', 'u1'),
    );

    const memory = newMemory();
    await ingestClaudeProjects(memory, { projectsDir });

    const [q] = await memory.provider.embed(['kangaroo elephant zebra']);
    const hits = memory.store.knn(q as number[], 1);
    const obs = hits[0] ? memory.store.getObservation(hits[0].id) : null;
    expect(obs?.content).toBe('kangaroo elephant zebra');

    memory.close();
  });
});

describe('ingestClaudeProjects — incremental', () => {
  it('re-ingest is a no-op (cursor → observationsAdded === 0)', async () => {
    const projDir = join(projectsDir, '-Users-me-Devs-foo');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 's.jsonl'),
      [
        userLine('sess-1', '/Users/me/Devs/foo', 'first message', 'u1'),
        assistantLine(
          'sess-1',
          '/Users/me/Devs/foo',
          [{ type: 'text', text: 'first reply' }],
          'a1',
        ),
      ].join('\n'),
    );

    const memory = newMemory();
    const first = await ingestClaudeProjects(memory, { projectsDir });
    expect(first.observationsAdded).toBe(2);
    expect(first.filesProcessed).toBe(1);

    const second = await ingestClaudeProjects(memory, { projectsDir });
    expect(second.observationsAdded).toBe(0);
    expect(second.filesProcessed).toBe(0);
    expect(second.filesSkipped).toBe(1);

    expect(memory.store.counts().observations).toBe(2);
    memory.close();
  });

  it('appending new lines then re-ingesting picks up only the new ones', async () => {
    const projDir = join(projectsDir, '-Users-me-Devs-foo');
    mkdirSync(projDir, { recursive: true });
    const file = join(projDir, 's.jsonl');
    writeFileSync(file, `${userLine('sess-1', '/Users/me/Devs/foo', 'msg one', 'u1')}\n`);

    const memory = newMemory();
    const first = await ingestClaudeProjects(memory, { projectsDir });
    expect(first.observationsAdded).toBe(1);

    appendFileSync(
      file,
      `${assistantLine('sess-1', '/Users/me/Devs/foo', [{ type: 'text', text: 'msg two' }], 'a1')}\n`,
    );

    const second = await ingestClaudeProjects(memory, { projectsDir });
    expect(second.observationsAdded).toBe(1);
    expect(second.filesProcessed).toBe(1);
    expect(memory.store.counts().observations).toBe(2);

    const session = memory.store.getSessionByExternalId('sess-1');
    const obs = memory.store.listObservations({ sessionId: session?.id });
    expect(obs.map((o) => o.content).sort()).toEqual(['msg one', 'msg two']);
    memory.close();
  });

  it('skips files entirely when nothing changed and counts them as skipped', async () => {
    const projDir = join(projectsDir, '-Users-me-Devs-foo');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'a.jsonl'),
      userLine('sess-a', '/Users/me/Devs/foo', 'alpha', 'u1'),
    );
    writeFileSync(join(projDir, 'b.jsonl'), userLine('sess-b', '/Users/me/Devs/foo', 'beta', 'u1'));

    const memory = newMemory();
    await ingestClaudeProjects(memory, { projectsDir });
    const second = await ingestClaudeProjects(memory, { projectsDir });
    expect(second.filesSkipped).toBe(2);
    expect(second.observationsAdded).toBe(0);
    memory.close();
  });
});

describe('ingestClaudeProjects — missing tree', () => {
  it('returns an empty tally when the projects dir does not exist', async () => {
    const memory = newMemory();
    const result = await ingestClaudeProjects(memory, {
      projectsDir: join(dir, 'does-not-exist'),
    });
    expect(result).toEqual({
      filesProcessed: 0,
      filesSkipped: 0,
      observationsAdded: 0,
      observationsSkipped: 0,
    });
    memory.close();
  });
});
