/**
 * `openMemory` — the one-call wiring of the whole memory stack: store (#3) +
 * embedding provider (#4) + index lifecycle (#5) + recall (#6). The CLI (#9) and
 * the MCP server (#6/#10) both build on this so the startup contract
 * (open → ensure index → ready) lives in exactly one place.
 */
import { type AppConfig, loadConfig } from './config.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './embedding/index.js';
import { type EnsureResult, Indexer } from './indexer/index.js';
import { Recall } from './recall/index.js';
import { MemoryStore } from './store/index.js';

export interface Memory {
  store: MemoryStore;
  provider: EmbeddingProvider;
  indexer: Indexer;
  recall: Recall;
  /** Result of the startup index check, when `ensure` ran. */
  ensure?: EnsureResult;
  close(): void;
}

export interface OpenMemoryOptions {
  /** Run the deterministic rebuild-on-startup gate. Default true. */
  ensure?: boolean;
}

export async function openMemory(
  config: AppConfig = loadConfig(),
  options: OpenMemoryOptions = {},
): Promise<Memory> {
  const store = new MemoryStore({
    dbPath: config.dbPath,
    dimensions: config.embedding.dimensions,
  }).open();
  const provider = createEmbeddingProvider(config.embedding);
  const indexer = new Indexer(store, provider);
  const recall = new Recall(store, provider);

  const ensure = options.ensure === false ? undefined : await indexer.ensureIndex();

  return {
    store,
    provider,
    indexer,
    recall,
    ensure,
    close: () => store.close(),
  };
}
