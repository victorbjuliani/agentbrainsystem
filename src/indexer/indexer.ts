/**
 * Index lifecycle (issue #5) — the central fix agentmemory got wrong.
 *
 * Ties the store (#3) to an embedding provider (#4) and guarantees the
 * `embed → persist → recall` path actually holds:
 *
 *   - **index-at-write**: writing an observation embeds it and persists the
 *     vector + FTS entry in the same store, durably (SQLite WAL).
 *   - **deterministic rebuild**: `rebuild()` re-derives the whole index from the
 *     stored observations; `ensureIndex()` fires it on startup when the index is
 *     missing, count-drifted, or built with a different embedding signature.
 *   - **real status**: `status()` reports actual row counts and the staleness
 *     verdict — never a cosmetic zero.
 *
 * agentmemory anti-patterns explicitly avoided: index only in-memory, never
 * persisted/rebuilt, and a rebuild gate that never triggers.
 */

import type { EmbeddingProvider } from '../embedding/index.js';
import { assertDimensions } from '../embedding/index.js';
import type { CreateObservationInput, MemoryStore } from '../store/index.js';

/** kv_meta key under which the embedding signature of the persisted index lives. */
const SIGNATURE_KEY = 'embed_signature';

/** Default embed batch size — keeps the working set small on an 8 GB machine. */
const DEFAULT_BATCH_SIZE = 64;

export interface IndexStatus {
  observations: number;
  vectors: number;
  fts: number;
  /** Embedding signature the persisted index was built with (null if never built). */
  signature: string | null;
  /** Signature the running config would produce now. */
  expectedSignature: string;
  /** True when the index does not faithfully reflect the stored observations. */
  stale: boolean;
}

export interface RebuildResult {
  indexed: number;
}

export interface EnsureResult {
  rebuilt: boolean;
  reason: 'fresh' | 'count-drift' | 'signature-change' | 'never-built';
  status: IndexStatus;
}

export interface IndexerOptions {
  batchSize?: number;
}

export class Indexer {
  private readonly store: MemoryStore;
  private readonly provider: EmbeddingProvider;
  private readonly batchSize: number;

  constructor(store: MemoryStore, provider: EmbeddingProvider, options: IndexerOptions = {}) {
    this.store = store;
    this.provider = provider;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /** Signature the active provider produces — `provider:model:dimensions`. */
  signature(): string {
    return `${this.provider.id}:${this.provider.model}:${this.provider.dimensions}`;
  }

  // ----------------------------------------------------------- index at write

  /**
   * Create an observation and index it (vector + FTS) in one step. This is the
   * write path callers should use so nothing lands unindexed.
   */
  async write(input: CreateObservationInput): Promise<number> {
    // Embed BEFORE any write: embedding is async and cannot sit inside
    // better-sqlite3's synchronous transaction. If it throws, nothing was
    // written — no orphan row, no compensating delete that could itself fail.
    const [vector] = await this.embedBatch([input.content]);
    if (vector === undefined) throw new Error('embedding produced no vector for observation');

    // Row + vector + FTS + signature commit as ONE unit: a throw or crash
    // between the statements rolls the whole thing back (no torn observation),
    // and the id is returned only after vector + FTS are committed together.
    return this.store.transaction(() => {
      const obsId = this.store.createObservation(input);
      this.store.upsertVector(obsId, vector);
      this.store.indexFts(obsId, input.content);
      this.store.setMeta(SIGNATURE_KEY, this.signature());
      return obsId;
    })();
  }

  /** (Re)index a single existing observation by id. */
  async indexObservation(obsId: number, content?: string): Promise<void> {
    const text = content ?? this.store.getObservation(obsId)?.content;
    if (text === undefined) throw new Error(`observation ${obsId} not found`);
    const [vector] = await this.embedBatch([text]);
    if (vector === undefined)
      throw new Error(`embedding produced no vector for observation ${obsId}`);
    this.store.upsertVector(obsId, vector);
    this.store.indexFts(obsId, text);
    // index-at-write implies the persisted index now reflects this provider;
    // stamp the signature so a later startup reads it as fresh, not never-built.
    this.store.setMeta(SIGNATURE_KEY, this.signature());
  }

  // -------------------------------------------------------- deterministic rebuild

  /**
   * Re-derive the entire index from the stored observations. Walks observations
   * in batches (streaming — no full materialization), embeds, and upsert-replaces
   * each vector + FTS entry, then prunes index rows whose observation no longer
   * exists. Crucially it does NOT pre-clear the index: an upsert-and-prune leaves
   * no window where recall sees an empty index (a crash mid-rebuild self-heals on
   * the next startup via the staleness gate). Stamps the signature on success.
   */
  async rebuild(): Promise<RebuildResult> {
    let indexed = 0;

    // Keyset pagination, NOT a single open cursor (#34): each page is a closed
    // `.all()` query, so embedding + writing the vectors/FTS back to the same
    // connection never collides with an in-flight row iterator ("database
    // connection is busy executing a query"). Footprint stays bounded — only one
    // batch of {id, content} is materialized at a time (ADR 0001).
    let afterId = 0;
    for (;;) {
      const page = this.store.listObservations({
        afterId,
        limit: this.batchSize,
        order: 'asc',
      });
      if (page.length === 0) break;

      const vectors = await this.embedBatch(page.map((o) => o.content));
      // assertDimensions checks width, not count; a short provider response would
      // leave observations unindexed and silently stamp success. Reject it.
      if (vectors.length !== page.length) {
        throw new Error(
          `embedding provider returned ${vectors.length} vectors for ${page.length} inputs`,
        );
      }
      for (let i = 0; i < page.length; i++) {
        const entry = page[i];
        const vector = vectors[i];
        if (entry === undefined || vector === undefined) continue;
        this.store.upsertVector(entry.id, vector);
        this.store.indexFts(entry.id, entry.content);
        indexed++;
      }
      // Advance the keyset cursor past the last row of this page.
      afterId = page[page.length - 1]?.id ?? afterId;
    }

    // Drop stale index rows for observations that no longer exist.
    this.store.pruneIndexOrphans();
    this.store.setMeta(SIGNATURE_KEY, this.signature());
    return { indexed };
  }

  // -------------------------------------------------------------- startup gate

  /**
   * Compute the index status without mutating anything. `stale` is true when the
   * persisted index cannot be trusted to reflect the stored observations.
   */
  status(): IndexStatus {
    const counts = this.store.counts();
    const signature = this.store.getMeta(SIGNATURE_KEY);
    const expectedSignature = this.signature();
    const { reason } = this.staleness(counts, signature, expectedSignature);
    return {
      observations: counts.observations,
      vectors: counts.vectors,
      fts: counts.fts,
      signature,
      expectedSignature,
      stale: reason !== 'fresh',
    };
  }

  /**
   * Ensure the index is trustworthy on startup. Rebuilds deterministically when
   * the index is missing, count-drifted, or built with a different embedding
   * signature. A no-op (besides stamping) when already fresh.
   */
  async ensureIndex(): Promise<EnsureResult> {
    const counts = this.store.counts();
    const signature = this.store.getMeta(SIGNATURE_KEY);
    const expectedSignature = this.signature();
    const { reason } = this.staleness(counts, signature, expectedSignature);

    if (reason === 'fresh') {
      // Stamp the signature on a brand-new empty store so the first real write
      // does not later read as a signature change.
      if (signature === null) this.store.setMeta(SIGNATURE_KEY, expectedSignature);
      return { rebuilt: false, reason, status: this.status() };
    }

    await this.rebuild();
    return { rebuilt: true, reason, status: this.status() };
  }

  // ------------------------------------------------------------------ internals

  private staleness(
    counts: { observations: number; vectors: number; fts: number },
    signature: string | null,
    expectedSignature: string,
  ): { reason: EnsureResult['reason'] } {
    if (counts.observations === 0) return { reason: 'fresh' };
    if (signature === null) return { reason: 'never-built' };
    if (signature !== expectedSignature) return { reason: 'signature-change' };
    if (counts.vectors !== counts.observations || counts.fts !== counts.observations) {
      return { reason: 'count-drift' };
    }
    return { reason: 'fresh' };
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const vectors = await this.provider.embed(texts);
    return assertDimensions(vectors, this.provider.dimensions);
  }
}
