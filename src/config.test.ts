import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const ENV_KEYS = [
  'ABS_HOME',
  'ABS_DB_PATH',
  'ABS_EMBED_PROVIDER',
  'ABS_EMBED_MODEL',
  'ABS_EMBED_DIM',
  'ABS_LLM_BASE_URL',
  'ABS_LLM_MODEL',
  'ABS_LLM_API_KEY',
  'ABS_LLM_TIMEOUT_MS',
  'ABS_LLM_PRICE_PER_1K',
  'ABS_RECALL_SCOPE',
  'ABS_AUTO_DISTILL',
  'DISTILL_MIN_OBS',
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

  it('defaults recallScope to project (#47 — isolation by default)', () => {
    expect(loadConfig().recallScope).toBe('project');
  });

  it('honours ABS_RECALL_SCOPE=global', () => {
    process.env.ABS_RECALL_SCOPE = 'global';
    expect(loadConfig().recallScope).toBe('global');
  });

  it('throws on an unknown ABS_RECALL_SCOPE', () => {
    process.env.ABS_RECALL_SCOPE = 'nope';
    expect(() => loadConfig()).toThrow(/ABS_RECALL_SCOPE/);
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

  it('rejects lenient numeric forms for ABS_EMBED_DIM (1e3, trailing units)', () => {
    // F6-09: Number.parseInt('1e3') === 1 and Number.parseInt('768px') === 768 both
    // sneak past Number.isInteger; the raw string must be a clean integer.
    for (const v of ['1e3', '768px', ' 768', '7.5', '0x10']) {
      process.env.ABS_EMBED_DIM = v;
      expect(() => loadConfig()).toThrow(/ABS_EMBED_DIM/);
    }
  });

  it('throws on an unknown ABS_EMBED_PROVIDER', () => {
    process.env.ABS_EMBED_PROVIDER = 'nope';
    expect(() => loadConfig()).toThrow(/ABS_EMBED_PROVIDER/);
  });

  // --- LLM block (issue #12) -------------------------------------------------

  it('leaves llm undefined by default ($0/offline preserved)', () => {
    expect(loadConfig().llm).toBeUndefined();
  });

  it('builds the llm block from env when ABS_LLM_BASE_URL is set', () => {
    process.env.ABS_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.ABS_LLM_MODEL = 'qwen2.5';
    process.env.ABS_LLM_API_KEY = 'sk-abc';
    process.env.ABS_LLM_TIMEOUT_MS = '30000';
    process.env.ABS_LLM_PRICE_PER_1K = '0.002';
    const cfg = loadConfig();
    expect(cfg.llm).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5',
      apiKey: 'sk-abc',
      timeoutMs: 30000,
      pricePer1k: 0.002,
    });
  });

  it('defaults timeoutMs to 60000 and leaves apiKey/pricePer1k optional', () => {
    process.env.ABS_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.ABS_LLM_MODEL = 'qwen2.5';
    const cfg = loadConfig();
    expect(cfg.llm?.timeoutMs).toBe(60000);
    expect(cfg.llm?.apiKey).toBeUndefined();
    expect(cfg.llm?.pricePer1k).toBeUndefined();
  });

  it('throws if ABS_LLM_BASE_URL is set but ABS_LLM_MODEL is missing', () => {
    process.env.ABS_LLM_BASE_URL = 'http://localhost:11434/v1';
    expect(() => loadConfig()).toThrow(/ABS_LLM_MODEL/);
  });

  it('throws on a non-integer/non-positive ABS_LLM_TIMEOUT_MS', () => {
    process.env.ABS_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.ABS_LLM_MODEL = 'qwen2.5';
    process.env.ABS_LLM_TIMEOUT_MS = 'garbage';
    expect(() => loadConfig()).toThrow(/ABS_LLM_TIMEOUT_MS/);
    process.env.ABS_LLM_TIMEOUT_MS = '0';
    expect(() => loadConfig()).toThrow(/ABS_LLM_TIMEOUT_MS/);
  });

  it('rejects lenient numeric forms for ABS_LLM_TIMEOUT_MS (60s, 1e3)', () => {
    // F6-09: Number.parseInt('60s') === 60 and Number.parseInt('1e3') === 1 both pass
    // Number.isInteger; the raw string must be a clean integer.
    process.env.ABS_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.ABS_LLM_MODEL = 'qwen2.5';
    for (const v of ['60s', '1e3', '30000ms', ' 30000']) {
      process.env.ABS_LLM_TIMEOUT_MS = v;
      expect(() => loadConfig()).toThrow(/ABS_LLM_TIMEOUT_MS/);
    }
  });

  it('throws on a bad ABS_LLM_PRICE_PER_1K (non-finite or negative)', () => {
    process.env.ABS_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.ABS_LLM_MODEL = 'qwen2.5';
    process.env.ABS_LLM_PRICE_PER_1K = 'free';
    expect(() => loadConfig()).toThrow(/ABS_LLM_PRICE_PER_1K/);
    process.env.ABS_LLM_PRICE_PER_1K = '-1';
    expect(() => loadConfig()).toThrow(/ABS_LLM_PRICE_PER_1K/);
  });

  // --- Auto-distill cadence (issue #138) -------------------------------------

  it('defaults autoDistill to true (cadence on by default)', () => {
    expect(loadConfig().autoDistill).toBe(true);
  });

  it('honours ABS_AUTO_DISTILL falsey values (0/false/off, case-insensitive)', () => {
    for (const v of ['0', 'false', 'off', 'FALSE', 'Off']) {
      process.env.ABS_AUTO_DISTILL = v;
      expect(loadConfig().autoDistill).toBe(false);
    }
  });

  it('honours ABS_AUTO_DISTILL truthy values (1/true/on, case-insensitive)', () => {
    for (const v of ['1', 'true', 'on', 'TRUE', 'On']) {
      process.env.ABS_AUTO_DISTILL = v;
      expect(loadConfig().autoDistill).toBe(true);
    }
  });

  it('throws on an unknown ABS_AUTO_DISTILL value', () => {
    process.env.ABS_AUTO_DISTILL = 'maybe';
    expect(() => loadConfig()).toThrow(/ABS_AUTO_DISTILL/);
  });

  it('defaults distillMinObs to 25 (reuses the staleness bar)', () => {
    expect(loadConfig().distillMinObs).toBe(25);
  });

  it('honours a positive integer DISTILL_MIN_OBS override', () => {
    process.env.DISTILL_MIN_OBS = '50';
    expect(loadConfig().distillMinObs).toBe(50);
  });

  it('throws on a non-positive / non-integer DISTILL_MIN_OBS', () => {
    process.env.DISTILL_MIN_OBS = '0';
    expect(() => loadConfig()).toThrow(/DISTILL_MIN_OBS/);
    process.env.DISTILL_MIN_OBS = 'garbage';
    expect(() => loadConfig()).toThrow(/DISTILL_MIN_OBS/);
  });

  it('rejects lenient numeric forms for DISTILL_MIN_OBS (25x, 1e3)', () => {
    // F6-09: Number.parseInt('25x') === 25 and Number.parseInt('1e3') === 1 both pass
    // Number.isInteger; the raw string must be a clean integer.
    for (const v of ['25x', '1e3', '25.0', ' 25']) {
      process.env.DISTILL_MIN_OBS = v;
      expect(() => loadConfig()).toThrow(/DISTILL_MIN_OBS/);
    }
  });
});
