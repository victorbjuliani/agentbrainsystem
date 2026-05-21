/**
 * Central runtime configuration. Resolves where the memory store lives and which
 * embedding provider/dimensions are active. Everything is overridable by env so the
 * store is never hard-wired to a path that could get committed.
 *
 * This module is the one shared contract between the store layer (#3) and the
 * embedding layer (#4): both read `config.embedding.dimensions` and nothing else
 * from each other.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LlmConfig } from './llm/types.js';

/** Provider identifiers understood by the embedding factory (#4). */
export type EmbeddingProviderId = 'local' | 'gemini' | 'voyage';

export interface EmbeddingConfig {
  /** Active provider; local transformers.js by default ($0, offline). */
  provider: EmbeddingProviderId;
  /** Model id for the active provider. */
  model: string;
  /** Vector dimension the store and index are sized for. */
  dimensions: number;
}

export interface AppConfig {
  /** Base data directory (holds the DB + model cache). */
  dataDir: string;
  /** Absolute path to the SQLite memory store. */
  dbPath: string;
  embedding: EmbeddingConfig;
  /**
   * LLM provider config for consolidation (#12). Opt-in: only present when
   * `ABS_LLM_BASE_URL` is set, so the default stays $0/offline.
   */
  llm?: LlmConfig;
}

const DEFAULT_LLM_TIMEOUT_MS = 60000;

const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';
const VALID_PROVIDERS: readonly EmbeddingProviderId[] = ['local', 'gemini', 'voyage'];
/**
 * Native vector width per provider, used when `ABS_EMBED_DIM` is unset. Pairing
 * the dimension with the provider avoids the footgun where selecting a hosted
 * provider would otherwise size the store at the local default (384) and fail on
 * the first embed (e.g. Gemini returns 768).
 */
const PROVIDER_DEFAULT_DIM: Record<EmbeddingProviderId, number> = {
  local: 384,
  gemini: 768,
  voyage: 1024,
};

function defaultDataDir(): string {
  return process.env.ABS_HOME
    ? resolve(process.env.ABS_HOME)
    : join(homedir(), '.agentbrainsystem');
}

/**
 * Build the active config from environment, falling back to local-first defaults.
 * Pure and cheap — call it wherever config is needed rather than caching globally,
 * so tests can set env per-case.
 */
export function loadConfig(): AppConfig {
  const dataDir = defaultDataDir();
  const dbPath = process.env.ABS_DB_PATH
    ? resolve(process.env.ABS_DB_PATH)
    : join(dataDir, 'memory.db');

  const rawProvider = process.env.ABS_EMBED_PROVIDER;
  if (rawProvider && !VALID_PROVIDERS.includes(rawProvider as EmbeddingProviderId)) {
    throw new Error(
      `invalid ABS_EMBED_PROVIDER '${rawProvider}' — expected one of ${VALID_PROVIDERS.join(', ')}`,
    );
  }
  const provider = (rawProvider as EmbeddingProviderId) || 'local';
  const model = process.env.ABS_EMBED_MODEL || (provider === 'local' ? DEFAULT_LOCAL_MODEL : '');
  const dimensions = process.env.ABS_EMBED_DIM
    ? Number.parseInt(process.env.ABS_EMBED_DIM, 10)
    : PROVIDER_DEFAULT_DIM[provider];
  // Fail loud at startup rather than letting NaN/0 reach the vec0 DDL (float[NaN]).
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      `invalid ABS_EMBED_DIM '${process.env.ABS_EMBED_DIM}' — expected a positive integer`,
    );
  }

  return {
    dataDir,
    dbPath,
    embedding: { provider, model, dimensions },
    llm: loadLlmConfig(),
  };
}

/**
 * Resolve the optional LLM block. Returns `undefined` when `ABS_LLM_BASE_URL` is
 * unset so consolidation stays opt-in and the default remains $0/offline. When a
 * base URL is present the rest is validated at the boundary and throws an
 * actionable error rather than letting a bad value reach a request.
 */
function loadLlmConfig(): LlmConfig | undefined {
  const baseUrl = process.env.ABS_LLM_BASE_URL;
  if (!baseUrl) return undefined;

  const model = process.env.ABS_LLM_MODEL;
  if (!model) {
    throw new Error(
      'ABS_LLM_BASE_URL is set but ABS_LLM_MODEL is missing — set the model name ' +
        '(e.g. ABS_LLM_MODEL=qwen2.5)',
    );
  }

  const apiKey = process.env.ABS_LLM_API_KEY || undefined;

  let timeoutMs = DEFAULT_LLM_TIMEOUT_MS;
  if (process.env.ABS_LLM_TIMEOUT_MS) {
    timeoutMs = Number.parseInt(process.env.ABS_LLM_TIMEOUT_MS, 10);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `invalid ABS_LLM_TIMEOUT_MS '${process.env.ABS_LLM_TIMEOUT_MS}' — expected a positive integer`,
      );
    }
  }

  let pricePer1k: number | undefined;
  if (process.env.ABS_LLM_PRICE_PER_1K) {
    pricePer1k = Number(process.env.ABS_LLM_PRICE_PER_1K);
    if (!Number.isFinite(pricePer1k) || pricePer1k < 0) {
      throw new Error(
        `invalid ABS_LLM_PRICE_PER_1K '${process.env.ABS_LLM_PRICE_PER_1K}' — expected a finite number >= 0`,
      );
    }
  }

  return { baseUrl, model, apiKey, timeoutMs, pricePer1k };
}

export const DEFAULTS = {
  localModel: DEFAULT_LOCAL_MODEL,
  dimensions: PROVIDER_DEFAULT_DIM.local,
} as const;
