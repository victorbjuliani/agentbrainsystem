import { describe, expect, it } from 'vitest';
import { VERSION } from './version.js';

describe('VERSION', () => {
  it('is a semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
