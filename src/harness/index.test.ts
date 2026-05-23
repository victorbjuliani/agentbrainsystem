// src/harness/index.test.ts
import { describe, expect, it } from 'vitest';
import { defaultRegistry } from './index.js';

describe('defaultRegistry', () => {
  it('includes the Claude Code adapter', () => {
    expect(defaultRegistry().byId('claude-code')?.displayName).toBe('Claude Code');
  });

  it('includes the Codex adapter (#67)', () => {
    expect(defaultRegistry().byId('codex')?.displayName).toBe('Codex CLI');
  });

  it('the Claude adapter carries mcpBinary = claude (C2)', () => {
    expect(defaultRegistry().byId('claude-code')?.mcpBinary).toBe('claude');
  });
});
