import { describe, expect, it } from 'vitest';
import type { GraphNode, NodeType } from '../graph-types.js';
import { nextVisibleTypes, presentTypes } from './visible-types.js';

const node = (type: NodeType): GraphNode => ({
  id: `n:${type}`,
  type,
  label: type,
  sizeDriver: 0,
  createdAt: '2026-05-22T00:00:00.000Z',
});

const set = (...t: NodeType[]): Set<NodeType> => new Set(t);

describe('presentTypes', () => {
  it('collapses a payload to its distinct node types', () => {
    const got = presentTypes([node('session'), node('user'), node('user'), node('assistant')]);
    expect(got).toEqual(set('session', 'user', 'assistant'));
  });

  it('is empty for an empty payload', () => {
    expect(presentTypes([])).toEqual(new Set());
  });
});

describe('nextVisibleTypes', () => {
  const present = set('session', 'user', 'assistant');

  it('plain click isolates the clicked type', () => {
    expect(nextVisibleTypes(present, 'user', present, false)).toEqual(set('user'));
  });

  it('plain click on the already-isolated type restores all present', () => {
    expect(nextVisibleTypes(set('user'), 'user', present, false)).toEqual(present);
  });

  it('plain click on a different type re-isolates to that type', () => {
    expect(nextVisibleTypes(set('user'), 'assistant', present, false)).toEqual(set('assistant'));
  });

  it('additive click toggles the clicked type on', () => {
    expect(nextVisibleTypes(set('user'), 'assistant', present, true)).toEqual(
      set('user', 'assistant'),
    );
  });

  it('additive click toggles the clicked type off', () => {
    expect(nextVisibleTypes(set('user', 'assistant'), 'assistant', present, true)).toEqual(
      set('user'),
    );
  });

  it('additive toggle never empties the visible set (reverts to all present)', () => {
    expect(nextVisibleTypes(set('user'), 'user', present, true)).toEqual(present);
  });
});
