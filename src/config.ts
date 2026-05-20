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
}

const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DIMENSIONS = 384;

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

  const provider = (process.env.ABS_EMBED_PROVIDER as EmbeddingProviderId) || 'local';
  const model = process.env.ABS_EMBED_MODEL || (provider === 'local' ? DEFAULT_LOCAL_MODEL : '');
  const dimensions = process.env.ABS_EMBED_DIM
    ? Number.parseInt(process.env.ABS_EMBED_DIM, 10)
    : DEFAULT_DIMENSIONS;

  return {
    dataDir,
    dbPath,
    embedding: { provider, model, dimensions },
  };
}

export const DEFAULTS = {
  localModel: DEFAULT_LOCAL_MODEL,
  dimensions: DEFAULT_DIMENSIONS,
} as const;
