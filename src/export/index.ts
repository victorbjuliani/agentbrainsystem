/**
 * Export / Import a portable, versioned memory artifact (issue #8).
 *
 * The artifact is line-delimited JSON (JSONL): a header line followed by one
 * line per session and one line per observation (vector included inline). This
 * lets a large store stream out and back in without ever holding the whole
 * payload in a single string — the 8 GB footprint discipline from ADR 0001
 * (a `JSON.stringify(everything)` was an agentmemory OOM cause).
 *
 * Public API:
 *   - `exportStore(store, outPath)`            → write the artifact, return counts
 *   - `importStore(store, inPath, { mode })`   → load an artifact (replace|merge)
 *
 * Both take a `MemoryStore` instance (not `openMemory`) so callers/tests stay
 * fast and offline — no embedding provider is ever constructed here.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadConfig } from '../config.js';
import type { MemoryStore } from '../store/memory-store.js';
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type ExportHeader,
  type ExportResult,
  type ImportMode,
  type ImportResult,
  type ObservationLine,
  type SessionLine,
} from './types.js';

export type {
  ExportHeader,
  ExportResult,
  ImportMode,
  ImportResult,
  ObservationLine,
  SessionLine,
} from './types.js';
export { EXPORT_FORMAT, EXPORT_VERSION } from './types.js';

/**
 * Discover a store's vec0 column width without reaching into its private state.
 */
function probeDimensions(store: MemoryStore): number {
  return store.vectorDimensions;
}

/** Append one JSON object as a single line to a write stream, awaiting backpressure. */
function writeLine(stream: NodeJS.WritableStream, obj: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(obj)}\n`, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Stream the entire store to `outPath` as a versioned JSONL artifact.
 *
 * Observations are walked via `store.iterateObservations()` (row-at-a-time) so
 * the store never materializes in memory. Each observation carries its stored
 * embedding (or null) so an import recalls identically without re-embedding.
 */
export async function exportStore(store: MemoryStore, outPath: string): Promise<ExportResult> {
  const config = loadConfig();
  const counts = store.counts();
  // The vec0 column width is the source of truth for the artifact's dimension —
  // a store can be sized differently from the process-wide config default.
  const dimensions = probeDimensions(store);

  // session id → externalId, so observation lines can reference the stable key.
  const sessions = store.listSessions();
  const externalIdById = new Map<number, string>();
  for (const s of sessions) externalIdById.set(s.id, s.externalId);

  const stream = createWriteStream(outPath, { encoding: 'utf8' });
  const closed = new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('finish', resolve);
  });

  try {
    const header: ExportHeader = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      createdAt: new Date().toISOString(),
      embedding: {
        provider: config.embedding.provider,
        model: config.embedding.model,
        dimensions,
      },
      counts: { sessions: counts.sessions, observations: counts.observations },
    };
    await writeLine(stream, header);

    for (const s of sessions) {
      const line: SessionLine = {
        t: 'session',
        externalId: s.externalId,
        project: s.project,
        startedAt: s.startedAt,
        createdAt: s.createdAt,
        meta: s.meta,
      };
      await writeLine(stream, line);
    }

    let observations = 0;
    for (const obs of store.iterateObservations()) {
      const sessionExternalId = externalIdById.get(obs.sessionId);
      if (sessionExternalId === undefined) {
        // An observation with no resolvable session would be unimportable; skip it
        // rather than emit a dangling reference.
        continue;
      }
      const line: ObservationLine = {
        t: 'obs',
        sessionExternalId,
        kind: obs.kind,
        content: obs.content,
        metadata: obs.metadata,
        source: obs.source,
        createdAt: obs.createdAt,
        vector: store.getVector(obs.id),
      };
      await writeLine(stream, line);
      observations += 1;
    }

    stream.end();
    await closed;
    return { sessions: sessions.length, observations };
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

/**
 * Confirm the artifact's embedding dimension matches the target store's vec0
 * column width — vectors of the wrong width cannot be inserted. Runs BEFORE any
 * mutation so a `replace` never wipes a store it would then be unable to refill.
 */
function assertDimensionsMatch(store: MemoryStore, artifactDimensions: number): void {
  if (!Number.isInteger(artifactDimensions) || artifactDimensions <= 0) {
    throw new Error(
      `invalid export artifact: embedding.dimensions must be a positive integer (got ${String(
        artifactDimensions,
      )})`,
    );
  }
  const storeDimensions = probeDimensions(store);
  if (artifactDimensions !== storeDimensions) {
    throw new Error(
      `embedding dimension mismatch: artifact has ${artifactDimensions}, target store is sized for ${storeDimensions}`,
    );
  }
}

/** Parse + validate the header line against this reader's expectations. */
function parseHeader(raw: string, store: MemoryStore): ExportHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid export artifact: header line is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('invalid export artifact: missing header');
  }
  const header = parsed as Partial<ExportHeader>;
  if (header.format !== EXPORT_FORMAT) {
    throw new Error(
      `invalid export artifact: unexpected format '${String(header.format)}' (expected '${EXPORT_FORMAT}')`,
    );
  }
  if (header.version !== EXPORT_VERSION) {
    throw new Error(
      `unsupported export version ${String(header.version)} (this build reads version ${EXPORT_VERSION})`,
    );
  }
  const dims = header.embedding?.dimensions;
  if (typeof dims !== 'number') {
    throw new Error('invalid export artifact: header is missing embedding.dimensions');
  }
  assertDimensionsMatch(store, dims);
  return header as ExportHeader;
}

/** Delete every session (cascades to observations + index rows) → an empty store. */
function wipe(store: MemoryStore): void {
  for (const s of store.listSessions()) store.deleteSession(s.id);
  // Defensive: prune any index rows orphaned by a prior crash.
  store.pruneIndexOrphans();
}

/**
 * Load an artifact from `inPath` into `store`.
 *
 * `replace` wipes the target first; `merge` keeps existing rows and appends,
 * reusing a session when its `externalId` already exists. Imported observations
 * get fresh numeric ids — recall identity is by content/vector, not id — and
 * are reindexed (vector if present, FTS always).
 *
 * The file is read line-by-line via `readline` so a large artifact streams in
 * without materializing in memory.
 */
export async function importStore(
  store: MemoryStore,
  inPath: string,
  options: { mode: ImportMode },
): Promise<ImportResult> {
  const { mode } = options;

  const rl = createInterface({
    input: createReadStream(inPath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY, // treat \r\n and \n alike (Windows portability)
  });

  let header: ExportHeader | null = null;
  // externalId → local session id, populated as session lines arrive (or reused).
  const sessionIdByExternalId = new Map<string, number>();
  let sessionsImported = 0;
  let observationsImported = 0;

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      if (header === null) {
        header = parseHeader(line, store);
        // Header validated (incl. dimension match) — only now safe to mutate.
        if (mode === 'replace') wipe(store);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error('invalid export artifact: a data line is not valid JSON');
      }
      const record = parsed as { t?: string };

      if (record.t === 'session') {
        const s = record as SessionLine;
        if (mode === 'merge') {
          const existing = store.getSessionByExternalId(s.externalId);
          if (existing) {
            sessionIdByExternalId.set(s.externalId, existing.id);
            sessionsImported += 1;
            continue;
          }
        }
        const id = store.createSession({
          externalId: s.externalId,
          project: s.project,
          startedAt: s.startedAt,
          createdAt: s.createdAt,
          meta: s.meta,
        });
        sessionIdByExternalId.set(s.externalId, id);
        sessionsImported += 1;
        continue;
      }

      if (record.t === 'obs') {
        const o = record as ObservationLine;
        const sessionId = sessionIdByExternalId.get(o.sessionExternalId);
        if (sessionId === undefined) {
          throw new Error(
            `invalid export artifact: observation references unknown session '${o.sessionExternalId}'`,
          );
        }
        const newId = store.createObservation({
          sessionId,
          kind: o.kind,
          content: o.content,
          metadata: o.metadata,
          source: o.source,
          createdAt: o.createdAt,
        });
        if (o.vector !== null) store.upsertVector(newId, o.vector);
        store.indexFts(newId, o.content);
        observationsImported += 1;
      }

      // Unknown line type: ignore for forward-compatibility within the same version.
    }
  } catch (err) {
    rl.close();
    throw err;
  }

  if (header === null) {
    // No header line was ever seen. We only wipe AFTER validating the header,
    // so a `replace` against an empty/header-less file leaves the store untouched.
    throw new Error('invalid export artifact: file is empty or has no header');
  }

  return { sessionsImported, observationsImported };
}
