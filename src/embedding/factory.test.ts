import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingConfig } from '../config.js';
import { createEmbeddingProvider } from './factory.js';
import { GeminiEmbeddingProvider, VoyageEmbeddingProvider } from './hosted.js';
import { LocalEmbeddingProvider } from './local.js';

const KEY_ENVS = ['GEMINI_API_KEY', 'VOYAGE_API_KEY'];

describe('createEmbeddingProvider', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEY_ENVS.map((k) => [k, process.env[k]]));
    for (const k of KEY_ENVS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEY_ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns a LocalEmbeddingProvider for 'local' (no network, no construction cost)", () => {
    const config: EmbeddingConfig = {
      provider: 'local',
      model: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
    };
    const provider = createEmbeddingProvider(config);
    expect(provider).toBeInstanceOf(LocalEmbeddingProvider);
    expect(provider.id).toBe('local');
    expect(provider.dimensions).toBe(384);
  });

  it('throws a clear error for gemini without an API key', () => {
    const config: EmbeddingConfig = { provider: 'gemini', model: '', dimensions: 768 };
    expect(() => createEmbeddingProvider(config)).toThrow(/gemini requires API key GEMINI_API_KEY/);
  });

  it('throws a clear error for voyage without an API key', () => {
    const config: EmbeddingConfig = { provider: 'voyage', model: '', dimensions: 1024 };
    expect(() => createEmbeddingProvider(config)).toThrow(/voyage requires API key VOYAGE_API_KEY/);
  });

  it('constructs gemini/voyage when the API key is present', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.VOYAGE_API_KEY = 'test-key';
    const gemini = createEmbeddingProvider({ provider: 'gemini', model: '', dimensions: 768 });
    const voyage = createEmbeddingProvider({ provider: 'voyage', model: '', dimensions: 1024 });
    expect(gemini).toBeInstanceOf(GeminiEmbeddingProvider);
    expect(voyage).toBeInstanceOf(VoyageEmbeddingProvider);
    expect(gemini.dimensions).toBe(768);
    expect(voyage.dimensions).toBe(1024);
  });

  it('throws on an unknown provider id', () => {
    const config = { provider: 'bogus', model: '', dimensions: 384 } as unknown as EmbeddingConfig;
    expect(() => createEmbeddingProvider(config)).toThrow(/unknown embedding provider 'bogus'/);
  });
});
