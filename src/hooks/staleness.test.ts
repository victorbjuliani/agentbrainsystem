import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../store/index.js';
import {
  evaluateStaleness,
  OPTIMIZE_CURSOR_KEY,
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

describe('evaluateStaleness', () => {
  it('flags only at or above the threshold', () => {
    expect(evaluateStaleness('0', STALENESS_MIN_PENDING - 1).flagged).toBe(false);
    expect(evaluateStaleness('0', STALENESS_MIN_PENDING).flagged).toBe(true);
    expect(evaluateStaleness('0', STALENESS_MIN_PENDING + 10).flagged).toBe(true);
  });

  it('honors an injected threshold and surfaces the parsed cursor', () => {
    const v = evaluateStaleness('100', 3, 3);
    expect(v).toEqual({ cursor: 100, pending: 3, flagged: true });
  });
});

describe('store count primitives the staleness flag rides on', () => {
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

  it('counts observations added since a cursor high-water mark', () => {
    const session = store.createSession({ externalId: 's1' });
    expect(store.maxObservationId()).toBe(0);

    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(store.createObservation({ sessionId: session, kind: 'user', content: `c${i}` }));
    }
    const cursor = ids[2] as number; // optimized through the 3rd observation
    store.setMeta(OPTIMIZE_CURSOR_KEY, String(cursor));

    expect(store.maxObservationId()).toBe(ids[4]);
    // 2 observations landed after the cursor.
    expect(store.countObservationsSince(cursor)).toBe(2);
    // From a zero cursor, all 5 are pending.
    expect(store.countObservationsSince(0)).toBe(5);
  });
});
