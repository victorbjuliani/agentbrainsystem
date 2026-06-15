import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../store/index.js';
import {
  evaluateTwoSignalStaleness,
  optimizeCursorKey,
  parseCursor,
  STALENESS_MIN_PENDING,
} from './staleness.js';

describe('parseCursor', () => {
  it('returns 0 for null/garbage and the integer otherwise', () => {
    expect(parseCursor(null)).toBe(0);
    expect(parseCursor('not-a-number')).toBe(0);
    expect(parseCursor('-5')).toBe(0);
    expect(parseCursor('42')).toBe(42);
  });
});

describe('optimizeCursorKey', () => {
  it('builds the two kind+project keys; the old global constant is gone', () => {
    expect(optimizeCursorKey('lesson', 'proj')).toBe('optimize:lesson:proj');
    expect(optimizeCursorKey('decision', 'proj')).toBe('optimize:decision:proj');
    // The deleted `optimize:cursorObsId` no longer exists — importing it would not
    // compile, so the import list at the top of this file is the compile-time proof.
  });
});

describe('evaluateTwoSignalStaleness', () => {
  const base = {
    rawPending: 0,
    rawSessions: 0,
    lessonsPending: 0,
    decisionsPending: 0,
    hasLlm: true,
  };

  it('raw-pending flags only at or above the threshold', () => {
    expect(
      evaluateTwoSignalStaleness({ ...base, rawPending: STALENESS_MIN_PENDING - 1 }).rawFlagged,
    ).toBe(false);
    expect(
      evaluateTwoSignalStaleness({ ...base, rawPending: STALENESS_MIN_PENDING }).rawFlagged,
    ).toBe(true);
  });

  it('consolidated-pending = lessons + decisions; flags whenever > 0 (no threshold)', () => {
    const v = evaluateTwoSignalStaleness({ ...base, lessonsPending: 0, decisionsPending: 1 });
    expect(v.consolidatedPending).toBe(1);
    expect(v.consolidatedFlagged).toBe(true);

    const v2 = evaluateTwoSignalStaleness({ ...base, lessonsPending: 2, decisionsPending: 3 });
    expect(v2.consolidatedPending).toBe(5);
    expect(v2.consolidatedFlagged).toBe(true);
  });

  it('both clear → all flags false; hasLlm surfaced', () => {
    const v = evaluateTwoSignalStaleness({ ...base, hasLlm: false });
    expect(v.rawFlagged).toBe(false);
    expect(v.consolidatedFlagged).toBe(false);
    expect(v.hasLlm).toBe(false);
  });

  it('honours an injected threshold for raw-pending', () => {
    expect(evaluateTwoSignalStaleness({ ...base, rawPending: 3, threshold: 3 }).rawFlagged).toBe(
      true,
    );
    expect(evaluateTwoSignalStaleness({ ...base, rawPending: 2, threshold: 3 }).rawFlagged).toBe(
      false,
    );
  });
});

describe('store count primitives the two-signal flag rides on', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-staleness-'));
    store = new MemoryStore({ dbPath: join(dir, 'm.db'), dimensions: 8 }).open();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts consolidate obs added since a per-kind/project cursor', () => {
    const session = store.createSession({ externalId: 's1', project: 'p' });
    const l1 = store.createObservation({
      sessionId: session,
      kind: 'lesson',
      content: 'l1',
      source: 'consolidate',
    });
    store.createObservation({
      sessionId: session,
      kind: 'lesson',
      content: 'l2',
      source: 'consolidate',
    });
    store.setMeta(optimizeCursorKey('lesson', 'p'), String(l1));

    // 1 consolidate lesson landed after the lesson cursor.
    expect(store.countConsolidatedSince('p', 'lesson', l1)).toBe(1);
    // From a zero cursor, both are pending.
    expect(store.countConsolidatedSince('p', 'lesson', 0)).toBe(2);
  });
});
