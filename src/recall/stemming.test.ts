import { describe, expect, it } from 'vitest';
import { stemVariants } from './stemming.js';

describe('stemVariants', () => {
  it('keeps the original token and adds its english stem', () => {
    expect(stemVariants('running')).toEqual(['running', 'run']);
  });

  it('lists the original token first (stable order)', () => {
    expect(stemVariants('migrações')[0]).toBe('migrações');
  });

  it('covers Portuguese stems for the bilingual store', () => {
    expect(stemVariants('migrações')).toContain('migraçõ');
  });

  it('returns just the token when no stemmer shortens it', () => {
    // A short token every stemmer leaves intact collapses to a single variant.
    expect(stemVariants('git')).toEqual(['git']);
  });
});
