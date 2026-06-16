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
  /**
   * Recall scope (#47). `'project'` (default) isolates recall/injection to the
   * current session's project so memory from other projects never leaks in;
   * `'global'` is the opt-out for intentional store-wide recall. From
   * `ABS_RECALL_SCOPE`.
   */
  recallScope: RecallScope;
  /**
   * Auto-distill cadence (#138). When `true` (default) and an LLM is configured,
   * a substantial session ending spawns a detached `consolidate → optimize`
   * cadence. From `ABS_AUTO_DISTILL` (`0/1/true/false/on/off`, case-insensitive).
   */
  autoDistill: boolean;
  /**
   * Minimum observations in a just-ended session for the cadence to fire (#138).
   * Reuses the staleness bar (`STALENESS_MIN_PENDING`, 25). From `DISTILL_MIN_OBS`.
   */
  distillMinObs: number;
}

/** Recall isolation mode (#47). */
export type RecallScope = 'project' | 'global';

const VALID_RECALL_SCOPES: readonly RecallScope[] = ['project', 'global'];

const DEFAULT_LLM_TIMEOUT_MS = 60000;

/** Default min-obs bar for the auto-distill cadence (mirrors STALENESS_MIN_PENDING). */
const DEFAULT_DISTILL_MIN_OBS = 25;

const AUTO_DISTILL_TRUE = new Set(['1', 'true', 'on']);
const AUTO_DISTILL_FALSE = new Set(['0', 'false', 'off']);

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
 * Parse a strict positive-integer env var. Unlike `Number.parseInt`, which silently
 * truncates lenient forms (`'1e3'`→1, `'768px'`→768, `'7.5'`→7, `' 30000'`, `'0x10'`)
 * straight past `Number.isInteger`, this requires the raw string to be digits only.
 * Throws with `name` in the message on any non-integer or non-positive value. (F6-09)
 */
function parsePositiveIntEnv(name: string, raw: string): number {
  const n = /^[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid ${name} '${raw}' — expected a positive integer`);
  }
  return n;
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
  // Fail loud at startup rather than letting NaN/0 reach the vec0 DDL (float[NaN]).
  const dimensions = process.env.ABS_EMBED_DIM
    ? parsePositiveIntEnv('ABS_EMBED_DIM', process.env.ABS_EMBED_DIM)
    : PROVIDER_DEFAULT_DIM[provider];

  const rawScope = process.env.ABS_RECALL_SCOPE;
  if (rawScope && !VALID_RECALL_SCOPES.includes(rawScope as RecallScope)) {
    throw new Error(
      `invalid ABS_RECALL_SCOPE '${rawScope}' — expected one of ${VALID_RECALL_SCOPES.join(', ')}`,
    );
  }
  const recallScope = (rawScope as RecallScope) || 'project';

  const rawAutoDistill = process.env.ABS_AUTO_DISTILL;
  let autoDistill = true;
  if (rawAutoDistill !== undefined) {
    const normalized = rawAutoDistill.trim().toLowerCase();
    if (AUTO_DISTILL_TRUE.has(normalized)) autoDistill = true;
    else if (AUTO_DISTILL_FALSE.has(normalized)) autoDistill = false;
    else
      throw new Error(
        `invalid ABS_AUTO_DISTILL '${rawAutoDistill}' — expected one of 0/1/true/false/on/off`,
      );
  }

  let distillMinObs = DEFAULT_DISTILL_MIN_OBS;
  if (process.env.DISTILL_MIN_OBS) {
    distillMinObs = parsePositiveIntEnv('DISTILL_MIN_OBS', process.env.DISTILL_MIN_OBS);
  }

  return {
    dataDir,
    dbPath,
    embedding: { provider, model, dimensions },
    llm: loadLlmConfig(),
    recallScope,
    autoDistill,
    distillMinObs,
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
    timeoutMs = parsePositiveIntEnv('ABS_LLM_TIMEOUT_MS', process.env.ABS_LLM_TIMEOUT_MS);
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
