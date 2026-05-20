import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const ENV_KEYS = [
  'ABS_HOME',
  'ABS_DB_PATH',
  'ABS_EMBED_PROVIDER',
  'ABS_EMBED_MODEL',
  'ABS_EMBED_DIM',
];

describe('loadConfig', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults to local provider, 384 dims', () => {
    const cfg = loadConfig();
    expect(cfg.embedding.provider).toBe('local');
    expect(cfg.embedding.dimensions).toBe(384);
    expect(cfg.dbPath).toMatch(/memory\.db$/);
  });

  it('honours ABS_HOME for db path', () => {
    process.env.ABS_HOME = '/tmp/abs-test';
    const cfg = loadConfig();
    expect(cfg.dataDir).toBe('/tmp/abs-test');
    expect(cfg.dbPath).toBe('/tmp/abs-test/memory.db');
  });

  it('honours explicit ABS_DB_PATH and dim override', () => {
    process.env.ABS_DB_PATH = '/tmp/custom.db';
    process.env.ABS_EMBED_DIM = '768';
    process.env.ABS_EMBED_PROVIDER = 'gemini';
    const cfg = loadConfig();
    expect(cfg.dbPath).toBe('/tmp/custom.db');
    expect(cfg.embedding.dimensions).toBe(768);
    expect(cfg.embedding.provider).toBe('gemini');
  });

  it('defaults dimensions per provider when ABS_EMBED_DIM is unset', () => {
    process.env.ABS_EMBED_PROVIDER = 'gemini';
    expect(loadConfig().embedding.dimensions).toBe(768);
    process.env.ABS_EMBED_PROVIDER = 'voyage';
    expect(loadConfig().embedding.dimensions).toBe(1024);
  });

  it('throws on a non-integer ABS_EMBED_DIM instead of leaking NaN to the schema', () => {
    process.env.ABS_EMBED_DIM = 'garbage';
    expect(() => loadConfig()).toThrow(/ABS_EMBED_DIM/);
  });

  it('throws on a zero/negative ABS_EMBED_DIM', () => {
    process.env.ABS_EMBED_DIM = '0';
    expect(() => loadConfig()).toThrow(/ABS_EMBED_DIM/);
  });

  it('throws on an unknown ABS_EMBED_PROVIDER', () => {
    process.env.ABS_EMBED_PROVIDER = 'nope';
    expect(() => loadConfig()).toThrow(/ABS_EMBED_PROVIDER/);
  });
});
