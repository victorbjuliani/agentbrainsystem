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
    /** Names that resolve to MORE than one location (homonyms). */
    private readonly ambiguous: Set<string> = new Set(),
  ) {}
  isAvailable(): boolean {
    return true;
  }
  resolveSymbol(
    name: string,
    opts: { filePath?: string; unique?: boolean } = {},
  ): ResolvedSymbol | null {
    const hit = this.symbols[name];
    if (!hit) return null;
    if (opts.filePath && opts.filePath !== hit.filePath) return null; // not at that file
    if (opts.unique && this.ambiguous.has(name)) return null; // ambiguous → refuse
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

  it('does NOT re-anchor to a homonym — ambiguous name goes stale (Codex P1)', () => {
    // `helper` was verified in old.ts; old.ts no longer has it, and `helper`
    // now exists in MULTIPLE other files. Re-anchoring would bind to an unrelated
    // homonym, so the fact must go stale instead.
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'helper',
      filePath: '/r/old.ts',
      state: 'verified',
    });
    const provider = new FakeProvider(
      { helper: { qualifiedName: 'helper', filePath: '/r/elsewhere.ts', line: 1 } },
      new Set(),
      new Set(['helper']), // homonym: resolves to >1 location
    );
    const res = healAnchors(store, provider);
    expect(res).toMatchObject({ reanchored: 0, staled: 1 });
    const a = store.findAnchorsBySymbol('helper')[0];
    expect(a?.state).toBe('stale');
    expect(a?.filePath).toBe('/r/old.ts'); // not moved to the homonym
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

  it('verifyOnRecall RECOVERS a stale anchor when its symbol resolves again (#137/F7-01)', () => {
    // `stale` was terminal: a fact false-staled by a transient miss (empty/foreign index)
    // stayed demoted forever. verifyOnRecall now re-resolves stale anchors too, so once the
    // home index is back the fact returns to verified.
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'foo',
      filePath: '/r/a.ts',
      state: 'stale',
    });
    const provider = new FakeProvider(
      { foo: { qualifiedName: 'foo', filePath: '/r/a.ts', line: 7, commitSha: 'c3' } },
      new Set(),
    );
    const res = verifyOnRecall(store, provider, [obsId]);
    expect(res).toMatchObject({ processed: 1, ok: 1 });
    const a = store.findAnchorsBySymbol('foo')[0];
    expect(a?.state).toBe('verified');
    expect(a?.line).toBe(7);
  });

  it('verifyOnRecall leaves a genuinely-removed stale anchor stale (no false recovery)', () => {
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'gone',
      filePath: '/r/a.ts',
      state: 'stale',
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
