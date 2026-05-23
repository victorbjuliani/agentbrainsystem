// src/harness/types.test.ts
import { describe, expect, it } from 'vitest';
import type { HarnessAdapter, LifecycleMoment } from './types.js';

describe('HarnessAdapter contract', () => {
  it('a minimal fake adapter satisfies the contract', () => {
    const fake: HarnessAdapter = {
      id: 'fake',
      displayName: 'Fake',
      detect: async () => false,
      qualifies: () => ({ ok: true, missing: [] }),
      eventMap: { capture: ['Stop'], recall: ['PreInvocation'], guard: ['PreToolUse'] },
      install: async () => ({ wired: [] }),
      uninstall: async () => ({ removed: [] }),
      registerMcp: async () => ({ status: 'already' }),
      resolveSession: () => ({ sessionId: 'abc' }),
    };
    expect(fake.id).toBe('fake');
  });

  it('lifecycle moments are exactly capture | recall | guard', () => {
    const moments: LifecycleMoment[] = ['capture', 'recall', 'guard'];
    expect(moments).toHaveLength(3);
  });
});
