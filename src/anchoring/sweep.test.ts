import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GroundTruthProvider, ResolvedSymbol } from '../ground-truth/index.js';
import { NullGroundTruthProvider } from '../ground-truth/index.js';
import { MemoryStore } from '../store/index.js';
import { sweepAnchors } from './sweep.js';

const DIM = 384;

/** A scripted provider: resolves only the symbols/files in its allow-set. */
class FakeProvider implements GroundTruthProvider {
  constructor(
    private readonly symbols: Record<string, ResolvedSymbol>,
    private readonly files: Set<string>,
    private readonly available = true,
  ) {}
  isAvailable(): boolean {
    return this.available;
  }
  resolveSymbol(name: string): ResolvedSymbol | null {
    return this.symbols[name] ?? null;
  }
  resolveFile(filePath: string): ResolvedSymbol | null {
    return this.files.has(filePath) ? { qualifiedName: filePath, filePath, commitSha: 'c1' } : null;
  }
  currentBranch(): string | undefined {
    return 'main';
  }
  close(): void {}
}

describe('sweepAnchors (#26)', () => {
  let dir: string;
  let store: MemoryStore;
  let obsId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-sweep-'));
    store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: DIM }).open();
    const sessionId = store.createSession({ externalId: 's', project: 'p' });
    obsId = store.createObservation({ sessionId, kind: 'tool_edit', content: 'edit' });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('promotes a resolvable symbol anchor to verified with file:line@commit', () => {
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'symbol',
      qualifiedName: 'foo',
      filePath: '/r/mod.ts',
    });
    const provider = new FakeProvider(
      { foo: { qualifiedName: 'mod.foo', filePath: '/r/mod.ts', line: 12, commitSha: 'abc' } },
      new Set(),
    );
    const res = sweepAnchors(store, provider);
    expect(res).toEqual({ processed: 1, verified: 1, unresolved: 0 });
    const a = store.findAnchorsBySymbol('foo')[0];
    expect(a?.state).toBe('verified');
    expect(a?.commitSha).toBe('abc');
    expect(a?.line).toBe(12);
    expect(a?.verifiedAt).toBeTruthy();
  });

  it('promotes a resolvable file anchor and leaves an unknown one claimed', () => {
    store.createAnchor({ observationId: obsId, anchorKind: 'file', filePath: '/r/known.ts' });
    store.createAnchor({ observationId: obsId, anchorKind: 'file', filePath: '/r/ghost.ts' });
    const provider = new FakeProvider({}, new Set(['/r/known.ts']));
    const res = sweepAnchors(store, provider);
    expect(res).toEqual({ processed: 2, verified: 1, unresolved: 1 });
    expect(store.findAnchorsByFile('/r/known.ts')[0]?.state).toBe('verified');
    expect(store.findAnchorsByFile('/r/ghost.ts')[0]?.state).toBe('claimed');
  });

  it('is a clean no-op when the provider is unavailable (fail-open)', () => {
    store.createAnchor({ observationId: obsId, anchorKind: 'file', filePath: '/r/x.ts' });
    const res = sweepAnchors(store, new NullGroundTruthProvider());
    expect(res).toEqual({ processed: 0, verified: 0, unresolved: 0 });
    expect(store.findAnchorsByFile('/r/x.ts')[0]?.state).toBe('claimed');
  });

  it('only sweeps claimed anchors — already-verified are left untouched', () => {
    store.createAnchor({
      observationId: obsId,
      anchorKind: 'file',
      filePath: '/r/v.ts',
      state: 'verified',
    });
    store.createAnchor({ observationId: obsId, anchorKind: 'file', filePath: '/r/c.ts' });
    const provider = new FakeProvider({}, new Set(['/r/v.ts', '/r/c.ts']));
    const res = sweepAnchors(store, provider);
    expect(res.processed).toBe(1); // only the claimed one
    expect(res.verified).toBe(1);
  });

  it('honours the batch limit', () => {
    for (let i = 0; i < 5; i++) {
      store.createAnchor({ observationId: obsId, anchorKind: 'file', filePath: `/r/f${i}.ts` });
    }
    const provider = new FakeProvider(
      {},
      new Set(['/r/f0.ts', '/r/f1.ts', '/r/f2.ts', '/r/f3.ts', '/r/f4.ts']),
    );
    const res = sweepAnchors(store, provider, { limit: 2 });
    expect(res.processed).toBe(2);
  });
});
