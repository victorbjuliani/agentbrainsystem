import { describe, expect, it, vi } from 'vitest';
import { fetchLatestVersion, isOutdated } from './update-check.js';

describe('isOutdated — strict x.y.z comparison', () => {
  it('is true only when latest is a higher release', () => {
    expect(isOutdated('1.0.1', '1.0.2')).toBe(true);
    expect(isOutdated('1.0.2', '1.1.0')).toBe(true);
    expect(isOutdated('1.0.2', '2.0.0')).toBe(true);
  });

  it('is false when equal or ahead', () => {
    expect(isOutdated('1.0.2', '1.0.2')).toBe(false);
    expect(isOutdated('1.1.0', '1.0.9')).toBe(false);
    expect(isOutdated('2.0.0', '1.9.9')).toBe(false);
  });

  it('tolerates short/garbled version strings without throwing', () => {
    expect(isOutdated('1.0', '1.0.1')).toBe(true);
    expect(isOutdated('1.0.0', 'not-a-version')).toBe(false);
  });
});

describe('fetchLatestVersion — best-effort, offline-safe', () => {
  it('returns the published version on a 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await fetchLatestVersion({ timeoutMs: 100 })).toBe('1.2.3');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns null (never throws) on network error or non-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));
    try {
      expect(await fetchLatestVersion({ timeoutMs: 100 })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
