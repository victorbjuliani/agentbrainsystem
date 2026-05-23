// src/harness/index.test.ts
import { describe, expect, it } from 'vitest';
import { defaultRegistry } from './index.js';

describe('defaultRegistry', () => {
  it('includes the Claude Code adapter', () => {
    expect(defaultRegistry().byId('claude-code')?.displayName).toBe('Claude Code');
  });
});
