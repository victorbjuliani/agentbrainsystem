import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { EmbeddingLoadTimeoutError } from '../embedding/index.js';
import type { GroundTruthProvider, ResolvedSymbol } from '../ground-truth/index.js';
import { type Memory, openMemory } from '../memory.js';
import { acquireRebuildLock, EMBED_DEGRADED_KEY, INGEST_DEFERRED_KEY } from '../store/index.js';
import { handleSessionEnd } from './session-end.js';

describe('handleSessionEnd — auto-ingest, $0, no injection', () => {
  it('ingests ONLY the current session transcript and returns undefined (#62)', async () => {
    const ingest = vi.fn(async (_path: string) => {});
    const result = await handleSessionEnd(
      { sessionId: 's1', transcriptPath: '/p/-Users-me/s1.jsonl' },
      { ingest },
    );
    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledWith('/p/-Users-me/s1.jsonl');
    expect(result).toBeUndefined();
  });

  it('is a no-op (never a full-tree scan) when the payload has no transcript_path (#62)', async () => {
    const ingest = vi.fn(async (_path: string) => {});
    const result = await handleSessionEnd({ sessionId: 's1' }, { ingest });
    expect(ingest).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('propagates an ingest failure to the caller (runner swallows it)', async () => {
    const ingest = vi.fn(async (_path: string) => {
      throw new Error('ingest exploded');
    });
    await expect(handleSessionEnd({ transcriptPath: '/p/x/s.jsonl' }, { ingest })).rejects.toThrow(
      'ingest exploded',
    );
  });
});

/** A provider that resolves exactly one symbol name to a fixed location. */
function providerFor(name: string): GroundTruthProvider {
  return {
    isAvailable: () => true,
    currentBranch: () => 'main',
    resolveSymbol: (n: string): ResolvedSymbol | null =>
      n === name ? { qualifiedName: n, filePath: 'src/x.ts', line: 10, commitSha: 'abc' } : null,
    resolveFile: () => null,
    close: () => {},
  };
}

describe('SessionEnd wires the anchor sweep (claimed → verified, #26 integration)', () => {
  let dir: string;
  let memory: Memory;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'abs-se-sweep-'));
    process.env.ABS_HOME = dir;
    memory = await openMemory();
  });
  afterEach(() => {
    memory.close();
    delete process.env.ABS_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  it('promotes a freshly-seeded claimed anchor to verified when ground truth resolves it', async () => {
    // Real store API: an observation needs a numeric session FK; project lives on the
    // session, not the observation (src/store/types.ts CreateSessionInput/CreateObservationInput).
    const sid = memory.store.createSession({ externalId: 's1', project: 'demo' });
    const obsId = memory.store.createObservation({
      sessionId: sid,
      kind: 'decision',
      content: 'mergeNotes must be order-stable',
    });
    memory.store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'mergeNotes',
      filePath: 'src/x.ts',
    });
    expect(memory.store.getAnchorsForObservation(obsId)[0]?.state).toBe('claimed');
    memory.close(); // hand the isolated store off to the handler's own connection

    const t = join(dir, 't.jsonl');
    writeFileSync(t, ''); // empty transcript: ingest is a no-op; the SWEEP is what we test
    // Do NOT inject `ingest` — the REAL path must run (opens ABS_HOME=dir). Inject only
    // `groundTruth` so createGroundTruthProvider(cwd) is never reached: a unit test must
    // never touch the developer's real store or the repo's real .code-review-graph/graph.db.
    await handleSessionEnd(
      { transcriptPath: t, cwd: dir },
      { groundTruth: providerFor('mergeNotes') },
    );

    memory = await openMemory(); // reopen to assert (afterEach closes this one)
    expect(memory.store.getAnchorsForObservation(obsId)[0]?.state).toBe('verified');
  });
});

describe('SessionEnd defers ingest while a rebuild holds the write lock (#103)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-se-defer-'));
    process.env.ABS_HOME = dir;
  });
  afterEach(() => {
    delete process.env.ABS_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a deferral marker and skips ingest instead of racing into busy_timeout', async () => {
    const cfg = loadConfig();
    // Materialize the db dir then hold the cross-process rebuild lock.
    (await openMemory(undefined, { ensure: false })).close();
    const lock = acquireRebuildLock(cfg.dbPath);

    const t = join(dir, 't.jsonl');
    writeFileSync(t, '{"role":"user","text":"hi"}\n');

    // Real path (no injected ingest) → the lock check must short-circuit it.
    const result = await handleSessionEnd({ transcriptPath: t, cwd: dir });
    expect(result).toBeUndefined();

    const mem = await openMemory(undefined, { ensure: false });
    try {
      expect(mem.store.getMeta(INGEST_DEFERRED_KEY)).not.toBeNull();
      // Nothing was ingested while deferred.
      expect(mem.store.counts().observations).toBe(0);
    } finally {
      mem.close();
    }
    lock.release();
  });
});

describe('SessionEnd defers ingest when the first-run model load times out (#111)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-se-embed-'));
    process.env.ABS_HOME = dir;
  });
  afterEach(() => {
    delete process.env.ABS_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  it('records EMBED_DEGRADED_KEY and skips ingest (fail-open) when ensureReady times out', async () => {
    const t = join(dir, 't.jsonl');
    writeFileSync(t, '{"role":"user","text":"hi"}\n');

    // Real path (no injected ingest) so the embed-readiness gate runs; the seam makes
    // the first-run download exceed its budget deterministically (the model is cached
    // by other tests, so a real ensureReady would just resolve).
    const embedReady = vi.fn(async () => {
      throw new EmbeddingLoadTimeoutError('Xenova/all-MiniLM-L6-v2', 6_000);
    });
    const result = await handleSessionEnd({ transcriptPath: t, cwd: dir }, { embedReady });
    expect(result).toBeUndefined();
    expect(embedReady).toHaveBeenCalledOnce();

    const mem = await openMemory(undefined, { ensure: false });
    try {
      expect(mem.store.getMeta(EMBED_DEGRADED_KEY)).not.toBeNull();
      // The session was NOT ingested — its cursor never advanced, so a later
      // unbudgeted `abs ingest` re-pulls it once the model caches.
      expect(mem.store.counts().observations).toBe(0);
    } finally {
      mem.close();
    }
  });

  it('propagates a non-timeout ensureReady failure to the caller (runner swallows it)', async () => {
    const t = join(dir, 't.jsonl');
    writeFileSync(t, '{"role":"user","text":"hi"}\n');
    const embedReady = vi.fn(async () => {
      throw new Error('model registry unreachable');
    });
    await expect(handleSessionEnd({ transcriptPath: t, cwd: dir }, { embedReady })).rejects.toThrow(
      'model registry unreachable',
    );
  });
});
