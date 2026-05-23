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

  it('includes the Gemini adapter (#68)', () => {
    expect(defaultRegistry().byId('gemini')?.displayName).toBe('Gemini CLI');
  });

  it('includes the Copilot adapter (#69)', () => {
    expect(defaultRegistry().byId('copilot')?.displayName).toBe('GitHub Copilot CLI');
  });

  it('registers all four qualifying adapters (#69)', () => {
    expect(defaultRegistry().all().length).toBe(4);
  });

  it('the Claude adapter carries mcpBinary = claude (C2)', () => {
    expect(defaultRegistry().byId('claude-code')?.mcpBinary).toBe('claude');
  });
});
