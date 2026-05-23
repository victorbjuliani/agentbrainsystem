// src/harness/capabilities/context-injector.test.ts
import { describe, expect, it } from 'vitest';
import { stdoutInjector } from './context-injector.js';

describe('stdoutInjector', () => {
  it('builds the Claude additionalContext JSON line for a recall moment', () => {
    const injector = stdoutInjector();
    const line = injector.render('SessionStart', 'recalled fact');
    expect(line).toContain('"additionalContext":"recalled fact"');
  });

  it('returns null for empty text', () => {
    const injector = stdoutInjector();
    expect(injector.render('SessionStart', '   ')).toBeNull();
  });
});
