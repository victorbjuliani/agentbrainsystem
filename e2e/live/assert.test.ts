import { describe, expect, it } from 'vitest';
import { assertBehavioral, assertInjection } from './assert.js';
import { EXPECTED_KEYWORDS } from './prompts.js';

describe('assertInjection', () => {
  it('passes when the recalled-memory fence carries the decision', () => {
    const inj =
      'Relevant memory recalled from project "x"...\n<recalled-memory>\n' +
      '- [assistant] store monetary amounts as integer cents, never floats\n</recalled-memory>';
    expect(assertInjection(inj, [/cent/i]).ok).toBe(true);
  });
  it('fails when there is no injection at all', () => {
    expect(assertInjection(undefined, [/cent/i]).ok).toBe(false);
  });
  it('fails when the fence is missing the expected keyword', () => {
    const inj = '<recalled-memory>\n- [assistant] unrelated note\n</recalled-memory>';
    expect(assertInjection(inj, [/cent/i]).ok).toBe(false);
  });
});

describe('assertBehavioral', () => {
  it('passes when the answer satisfies every keyword-set', () => {
    const answer = 'Use integer cents, and keep the token in an httpOnly cookie.';
    const r = assertBehavioral(answer, [...EXPECTED_KEYWORDS.money, ...EXPECTED_KEYWORDS.token]);
    expect(r.ok).toBe(true);
  });
  it('reports which keyword-set was missed', () => {
    const r = assertBehavioral('Use integer cents.', [/httponly/i]);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('/httponly/i');
  });
});
