/**
 * SqliteTranscriptSource tests (#72, Task 2) — read-only opencode.db ingest with an
 * id-anchored per-session watermark (at-least-once, never a silent drop). Builds a
 * temp opencode.db via the shared fixture and ingests into a temp memory store.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../../embedding/index.js';
import { Indexer } from '../../indexer/index.js';
import type { Memory } from '../../memory.js';
import { Recall } from '../../recall/index.js';
import { MemoryStore } from '../../store/index.js';
import { appendParts, buildOpencodeDb, deletePart } from './__fixtures__/opencode-db.js';
import { sqliteTranscriptSource } from './sqlite-transcript-source.js';

const SES = 'ses_1e1ffd31affeOz4vj2gNwUXRRA';
const DIR = '/Users/test/Devs/ChessTrainer';

/** Deterministic, offline provider so the ingest tests run without a model download. */
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

describe('sqliteTranscriptSource (#72)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'abs-oc-src-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function open(): Promise<Memory> {
    const store = new MemoryStore({ dbPath: join(home, 'memory.db'), dimensions: 8 }).open();
    const provider = new FakeProvider();
    const indexer = new Indexer(store, provider);
    const recall = new Recall(store, provider);
    return { store, provider, indexer, recall, close: () => store.close() };
  }

  function dbWith3Parts(): string {
    return buildOpencodeDb(join(home, 'opencode.db'), [
      {
        id: SES,
        directory: DIR,
        messages: [
          {
            id: 'msg_1',
            role: 'user',
            parts: [{ id: 'prt_1', text: 'how do I castle' }],
          },
          {
            id: 'msg_2',
            role: 'assistant',
            parts: [
              { id: 'prt_2', text: 'You castle by moving the king two squares.' },
              { id: 'prt_3', text: 'Kingside is O-O, queenside O-O-O.' },
            ],
          },
        ],
      },
    ]);
  }

  it('(a) cold ingest: 3 text parts → 3 observations under opencode:ses_, project from directory', async () => {
    const dbPath = dbWith3Parts();
    const memory = await open();
    try {
      const result = await sqliteTranscriptSource({ dbPath }).ingestSession(memory, SES);
      expect(result.observationsAdded).toBe(3);
      const session = memory.store.getSessionByExternalId(`opencode:${SES}`);
      expect(session).not.toBeNull();
      // project derived from session.directory (NOT message.data.path.cwd, empty on user msgs)
      expect(session?.project).toBe(`-Users-test-Devs-ChessTrainer`);
      const obs = memory.store.listObservations({ project: session?.project, order: 'asc' });
      expect(obs.map((o) => o.content)).toEqual([
        'how do I castle',
        'You castle by moving the king two squares.',
        'Kingside is O-O, queenside O-O-O.',
      ]);
    } finally {
      memory.close();
    }
  });

  it('(a2) two parts of ONE message are stamped from part time, not message time (#90c)', async () => {
    const dbPath = buildOpencodeDb(join(home, 'opencode.db'), [
      {
        id: SES,
        directory: DIR,
        messages: [
          {
            id: 'msg_1',
            role: 'assistant',
            time: 5_000, // message time — the OLD code stamped BOTH parts with this
            parts: [
              { id: 'prt_1', text: 'first chunk', time: 5_000 },
              { id: 'prt_2', text: 'later chunk emitted much later', time: 9_000 },
            ],
          },
        ],
      },
    ]);
    const memory = await open();
    try {
      await sqliteTranscriptSource({ dbPath }).ingestSession(memory, SES);
      const session = memory.store.getSessionByExternalId(`opencode:${SES}`);
      const obs = memory.store.listObservations({ project: session?.project, order: 'asc' });
      expect(obs).toHaveLength(2);
      // Distinct part times → distinct createdAt (the bug collapsed both to msg time).
      expect(obs[0]?.createdAt).toBe(new Date(5_000).toISOString());
      expect(obs[1]?.createdAt).toBe(new Date(9_000).toISOString());
      expect(obs[0]?.createdAt).not.toBe(obs[1]?.createdAt);
    } finally {
      memory.close();
    }
  });

  it('(b) at-least-once watermark: re-run with no new parts adds 0', async () => {
    const dbPath = dbWith3Parts();
    const memory = await open();
    try {
      await sqliteTranscriptSource({ dbPath }).ingestSession(memory, SES);
      const again = await sqliteTranscriptSource({ dbPath }).ingestSession(memory, SES);
      expect(again.observationsAdded).toBe(0);
      const session = memory.store.getSessionByExternalId(`opencode:${SES}`);
      expect(memory.store.listObservations({ project: session?.project }).length).toBe(3);
    } finally {
      memory.close();
    }
  });

  it('(c) incremental: append 2 parts → exactly 2 added (rides watermark)', async () => {
    const dbPath = dbWith3Parts();
    const memory = await open();
    try {
      await sqliteTranscriptSource({ dbPath }).ingestSession(memory, SES);
      appendParts(
        dbPath,
        SES,
        'msg_2',
        [
          { id: 'prt_4', text: 'Conditions: king and rook unmoved.' },
          { id: 'prt_5', text: 'No squares between under attack.' },
        ],
        5_000,
      );
      const inc = await sqliteTranscriptSource({ dbPath }).ingestSession(memory, SES);
      expect(inc.observationsAdded).toBe(2);
      const session = memory.store.getSessionByExternalId(`opencode:${SES}`);
      expect(memory.store.listObservations({ project: session?.project }).length).toBe(5);
    } finally {
      memory.close();
    }
  });

  it('(d) rewind: delete the watermarked part → re-syncs from 0 (dups tolerated, no drop)', async () => {
    const dbPath = dbWith3Parts();
    const memory = await open();
    try {
      await sqliteTranscriptSource({ dbPath }).ingestSession(memory, SES);
      // The watermark is prt_3 (last text part). Delete it → re-sync from start.
      deletePart(dbPath, 'prt_3');
      const after = await sqliteTranscriptSource({ dbPath }).ingestSession(memory, SES);
      // Remaining 2 parts (prt_1, prt_2) are re-ingested (at-least-once dup, never drop).
      expect(after.observationsAdded).toBe(2);
    } finally {
      memory.close();
    }
  });

  it('(e) non-text parts (reasoning/tool/step-start) skipped + counted', async () => {
    const dbPath = buildOpencodeDb(join(home, 'opencode.db'), [
      {
        id: SES,
        directory: DIR,
        messages: [
          {
            id: 'msg_1',
            role: 'assistant',
            parts: [
              { id: 'prt_a', type: 'step-start' },
              { id: 'prt_b', type: 'reasoning' },
              { id: 'prt_c', type: 'text', text: 'real prose here' },
              { id: 'prt_d', type: 'tool' },
            ],
          },
        ],
      },
    ]);
    const memory = await open();
    try {
      const result = await sqliteTranscriptSource({ dbPath }).ingestSession(memory, SES);
      expect(result.observationsAdded).toBe(1);
      expect(result.observationsSkipped).toBe(3);
    } finally {
      memory.close();
    }
  });

  it('(f) missing DB file → empty result, no throw', async () => {
    const memory = await open();
    try {
      const result = await sqliteTranscriptSource({
        dbPath: join(home, 'does-not-exist.db'),
      }).ingestSession(memory, SES);
      expect(result.observationsAdded).toBe(0);
    } finally {
      memory.close();
    }
  });

  it('(g) read-only: never writes to opencode.db (size/mtime unchanged)', async () => {
    const dbPath = dbWith3Parts();
    const before = statSync(dbPath);
    const memory = await open();
    try {
      await sqliteTranscriptSource({ dbPath }).ingestSession(memory, SES);
    } finally {
      memory.close();
    }
    const after = statSync(dbPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
