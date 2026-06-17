import { describe, expect, it } from 'vitest';
import { detectLocale, LOCALE_MESSAGE_IDS, t } from './locale.js';

/** Build a `getEnv`-shaped lookup from a plain record (undefined for absent keys). */
function env(vars: Record<string, string | undefined>): (k: string) => string | undefined {
  return (k) => vars[k];
}

describe('detectLocale', () => {
  it('maps a pt_BR LANG to "pt"', () => {
    expect(detectLocale(env({ LANG: 'pt_BR.UTF-8' }))).toBe('pt');
  });

  it('maps an en_US LANG to "en"', () => {
    expect(detectLocale(env({ LANG: 'en_US.UTF-8' }))).toBe('en');
  });

  it('prefers LC_ALL over LANG (precedence)', () => {
    expect(detectLocale(env({ LC_ALL: 'pt_PT.UTF-8', LANG: 'en_US.UTF-8' }))).toBe('pt');
    expect(detectLocale(env({ LC_ALL: 'en_GB.UTF-8', LANG: 'pt_BR.UTF-8' }))).toBe('en');
  });

  it('prefers LC_MESSAGES over LANG when LC_ALL is unset', () => {
    expect(detectLocale(env({ LC_MESSAGES: 'pt_BR.UTF-8', LANG: 'en_US.UTF-8' }))).toBe('pt');
  });

  it('falls back to "en" for an unset / empty locale', () => {
    expect(detectLocale(env({}))).toBe('en');
    expect(detectLocale(env({ LANG: '' }))).toBe('en');
    expect(detectLocale(env({ LC_ALL: '', LC_MESSAGES: '', LANG: '' }))).toBe('en');
  });

  it('falls back to "en" for a non-pt/en locale (fr_FR)', () => {
    expect(detectLocale(env({ LANG: 'fr_FR.UTF-8' }))).toBe('en');
  });

  it('matches a bare "pt" prefix and "C"/garbage → en', () => {
    expect(detectLocale(env({ LANG: 'pt' }))).toBe('pt');
    expect(detectLocale(env({ LANG: 'C' }))).toBe('en');
    expect(detectLocale(env({ LANG: 'garbage' }))).toBe('en');
  });
});

describe('string table completeness', () => {
  it('resolves every message id in BOTH pt and en (no missing key)', () => {
    for (const id of LOCALE_MESSAGE_IDS) {
      const pt = t('pt', id);
      const en = t('en', id);
      expect(typeof pt).toBe('string');
      expect(pt.length).toBeGreaterThan(0);
      expect(typeof en).toBe('string');
      expect(en.length).toBeGreaterThan(0);
    }
  });

  it('states the opt-out cost with the measured ADR-0017 numbers (~98% raw / ~0.5% durable)', () => {
    expect(t('pt', 'optOutCost')).toContain('98%');
    expect(t('en', 'optOutCost')).toContain('98%');
    expect(t('en', 'optOutCost')).toMatch(/0\.5%/);
  });
});
