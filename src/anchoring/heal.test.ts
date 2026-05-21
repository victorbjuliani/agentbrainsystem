import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GroundTruthProvider, ResolvedSymbol } from '../ground-truth/index.js';
import { NullGroundTruthProvider } from '../ground-truth/index.js';
import { MemoryStore } from '../store/index.js';
import { healAnchors, verifyOnRecall } from './heal.js';

const DIM = 384;

/** Provider scripted from a name→location map and a live-files set. */
class FakeProvider implements GroundTruthProvider {
  constructor(
    private readonly symbols: Record<string, ResolvedSymbol>,
    private readonly files: Set<string>,
  ) {}
  isAvailable(): boolean {
    return true;
  }
  resolveSymbol(name: string, opts: { filePath?: string } = {}): ResolvedSymbol | null {
    const hit = this.symbols[name];
    if (!hit) return null;
    if (opts.filePath && opts.filePath !== hit.filePath) return null; // not at that file
    return hit;
  }
  resolveFile(filePath: string): ResolvedSymbol | null {
    return this.files.has(filePath) ? { qualifiedName: filePath, filePath, commitSha: 'c' } : null;
  }
  currentBranch(): string | undefined {
    return 'main';
  }
  close(): void {}
}

describe('self-healing (#28)', () => {
  let dir: string;
  let store: MemoryStore;
  let obsId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-heal-'));
    store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: DIM }).open();
    const sessionId = store.createSession({ externalId: 's', project: 'p' });
    obsId = store.createObservation({ sessionId, kind: 'tool_edit', content: 'edit' });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps verified + re-pins line when the symbol still resolves at the same file', () => {
    const id = store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'foo',
      filePath: '/r/a.ts',
      state: 'verified',
      line: 1,
    });
    const provider = new FakeProvider(
      { foo: { qualifiedName: 'foo', filePath: '/r/a.ts', line: 9, commitSha: 'c2' } },
      new Set(),
    );
    const res = healAnchors(store, provider);
    expect(res).toMatchObject({ processed: 1, ok: 1, reanchored: 0, staled: 0 });
    expect(store.findAnchorsBySymbol('foo')[0]?.line).toBe(9);
    void id;
  });

  it('re-anchors (stays verified) when the symbol moved to a new file (rename)', () => {
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'foo',
      filePath: '/r/old.ts',
      state: 'verified',
    });
    const provider = new FakeProvider(
      { foo: { qualifiedName: 'foo', filePath: '/r/new.ts', line: 3, commitSha: 'c' } },
      new Set(),
    );
    const res = healAnchors(store, provider);
    expect(res).toMatchObject({ reanchored: 1, staled: 0 });
    const a = store.findAnchorsBySymbol('foo')[0];
    expect(a?.state).toBe('verified');
    expect(a?.filePath).toBe('/r/new.ts');
  });

  it('marks stale when the symbol no longer resolves anywhere (remove)', () => {
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'gone',
      filePath: '/r/a.ts',
      state: 'verified',
    });
    const provider = new FakeProvider({}, new Set());
    const res = healAnchors(store, provider);
    expect(res).toMatchObject({ staled: 1 });
    expect(store.findAnchorsBySymbol('gone')[0]?.state).toBe('stale');
  });

  it('marks a file anchor stale when its file is gone', () => {
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'file',
      filePath: '/r/dead.ts',
      state: 'verified',
    });
    const res = healAnchors(store, new FakeProvider({}, new Set()));
    expect(res).toMatchObject({ staled: 1 });
    expect(store.findAnchorsByFile('/r/dead.ts')[0]?.state).toBe('stale');
  });

  it('verifyOnRecall heals only the given observation ids, lazily', () => {
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'gone',
      filePath: '/r/a.ts',
      state: 'verified',
    });
    const res = verifyOnRecall(store, new FakeProvider({}, new Set()), [obsId]);
    expect(res).toMatchObject({ processed: 1, staled: 1 });
    expect(store.findAnchorsBySymbol('gone')[0]?.state).toBe('stale');
  });

  it('is a no-op when the provider is unavailable (fail-open)', () => {
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'foo',
      filePath: '/r/a.ts',
      state: 'verified',
    });
    expect(healAnchors(store, new NullGroundTruthProvider())).toMatchObject({ processed: 0 });
    expect(store.findAnchorsBySymbol('foo')[0]?.state).toBe('verified'); // untouched
  });
});
