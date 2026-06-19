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
import { createReadStream, createWriteStream, renameSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadConfig } from '../config.js';
import { OPENCODE_CURSOR_PREFIX } from '../harness/capabilities/sqlite-transcript-source.js';
import {
  CODEX_CWD_PREFIX,
  COPILOT_CWD_PREFIX,
  CURSOR_PREFIX,
  GEMINI_LASTID_PREFIX,
} from '../ingest/ingest.js';
import type { MemoryStore } from '../store/memory-store.js';
import { CAPTURE_FAILED_KEY, EMBED_DEGRADED_KEY, REBUILD_FAILED_KEY } from '../store/write-lock.js';
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

  // Pre-count the observations that will actually be WRITTEN — those whose session
  // resolves to an exported session. The header must declare THIS, not the raw total:
  // an orphan row (corrupt store; FK CASCADE normally prevents one) is skipped below,
  // so a header claiming the full `counts.observations` would over-declare and THIS
  // build's importer rejects the artifact as truncated (`observationLines.length <
  // header.counts.observations`) — i.e. an export this build cannot reimport (Codex
  // review on PR #165). The pre-pass is cheap: `iterateObservations` yields no vectors
  // (those load per-row only in the write loop below).
  let writableObservations = 0;
  for (const obs of store.iterateObservations()) {
    if (externalIdById.has(obs.sessionId)) writableObservations += 1;
  }

  // Write to a sibling temp path and only `rename` it over `outPath` after the
  // stream closes cleanly (F3-03). `createWriteStream` truncates its target up
  // front, so writing straight to `outPath` would leave it empty/partial on a
  // mid-write crash. A rename publishes the artifact atomically — `outPath` only
  // ever appears on full success.
  const tmpPath = `${outPath}.tmp`;
  const stream = createWriteStream(tmpPath, { encoding: 'utf8' });
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
      counts: { sessions: counts.sessions, observations: writableObservations },
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
    let danglingSkipped = 0;
    for (const obs of store.iterateObservations()) {
      const sessionExternalId = externalIdById.get(obs.sessionId);
      if (sessionExternalId === undefined) {
        // An observation with no resolvable session would be unimportable; skip it
        // rather than emit a dangling reference. Counted so the reconciliation
        // below distinguishes a legitimate skip from a lost row.
        danglingSkipped += 1;
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

    // Reconcile what we actually walked against the counts taken before the iteration
    // (F3-02). Two invariants: (1) we wrote EXACTLY the writable count the header
    // declares — so the artifact is self-consistent and reimports cleanly; (2) every
    // row `counts()` promised was seen (written or skipped-dangling) — a shortfall
    // means rows vanished mid-walk (a truncation/inconsistency) and finalizing would
    // publish a lying artifact that imports as a silent partial.
    const observationsSeen = observations + danglingSkipped;
    if (
      sessions.length !== counts.sessions ||
      observations !== writableObservations ||
      observationsSeen !== counts.observations
    ) {
      throw new Error(
        `export count mismatch: expected ${counts.sessions} sessions / ${writableObservations} writable observations; ` +
          `wrote ${sessions.length} sessions / ${observations} observations ` +
          `(+${danglingSkipped} dangling, ${observationsSeen} of ${counts.observations} total seen)`,
      );
    }

    // Success — publish the artifact atomically. Only now does `outPath` exist.
    renameSync(tmpPath, outPath);
    return { sessions: sessions.length, observations };
  } catch (err) {
    stream.destroy();
    // Drop the partial temp file so a failed export leaves no debris and never
    // touches `outPath`.
    rmSync(tmpPath, { force: true });
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

/**
 * kv_meta key prefixes whose values describe ingest PROGRESS, not durable user
 * intent. A `replace` is a full reset, so these must be cleared too (F3-04):
 * otherwise the next ingest resumes from cursors / degraded flags that point at
 * data the wipe just deleted, silently skipping records on resync.
 *
 * `session-project:*` bindings are deliberately ABSENT — they are explicit user
 * project decisions, not derived from the observation rows being replaced, so a
 * reset preserves them.
 */
const INGEST_STATE_META_PREFIXES = [
  CURSOR_PREFIX, // ingest:cursor:*
  CODEX_CWD_PREFIX, // codex:cwd:*
  COPILOT_CWD_PREFIX, // ingest:copilot-cwd:*
  GEMINI_LASTID_PREFIX, // gemini:lastid:*
  OPENCODE_CURSOR_PREFIX, // opencode:cursor:* (Codex review on PR #165)
];

/** Single-key ingest-state kv_meta flags cleared on a full reset (F3-04). */
const INGEST_STATE_META_KEYS = [REBUILD_FAILED_KEY, EMBED_DEGRADED_KEY, CAPTURE_FAILED_KEY];

/** Delete every ingest-progress kv_meta key/prefix — but never user bindings. */
function clearIngestStateMeta(store: MemoryStore): void {
  for (const prefix of INGEST_STATE_META_PREFIXES) {
    for (const key of store.listMetaKeys(prefix)) store.deleteMeta(key);
  }
  for (const key of INGEST_STATE_META_KEYS) store.deleteMeta(key);
}

/**
 * Delete every session (cascades to observations + index rows) → an empty store,
 * and clear ingest-progress bookkeeping so the next ingest does not resume from
 * stale cursors/flags (F3-04). PRESERVES `session-project:*` user bindings.
 */
function wipe(store: MemoryStore): void {
  for (const s of store.listSessions()) store.deleteSession(s.id);
  // Defensive: prune any index rows orphaned by a prior crash.
  store.pruneIndexOrphans();
  clearIngestStateMeta(store);
}

/**
 * Load an artifact from `inPath` into `store`.
 *
 * `replace` wipes the target first; `merge` keeps existing rows and appends,
 * reusing a session when its `externalId` already exists. Imported observations
 * get fresh numeric ids — recall identity is by content/vector, not id — and
 * are reindexed (vector if present, FTS always).
 *
 * Integrity (issue #157): the import is two-phase. PHASE 1 streams the file
 * line-by-line via `readline` (no materialized giant string) and parses + counts
 * every line WITHOUT touching the store. The dimension check runs in this phase,
 * before any mutation. Only once the whole file parses and its row count
 * reconciles against the header do we enter PHASE 2 — wipe (replace) plus all
 * inserts inside ONE `store.transaction()`, so any failure mid-apply rolls the
 * store back to its exact pre-import state (F3-01). A truncated artifact (header
 * declares more rows than are present) is rejected here, never imported as a
 * silent partial success (F3-02).
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

  // ---------------------------------------------------------------- PHASE 1
  // Parse + validate the whole artifact into ordered, in-memory records. No
  // store mutation happens here, so a parse/validation error leaves the target
  // untouched regardless of mode.
  let header: ExportHeader | null = null;
  const sessionLines: SessionLine[] = [];
  const observationLines: ObservationLine[] = [];
  // The set of session externalIds the artifact declares — observations may only
  // reference one of these (parse-time integrity, independent of store state).
  const declaredSessionIds = new Set<string>();

  // The readline interface holds an open file descriptor; close it on EVERY exit
  // path — normal return or any throw from phase 1, the validation below, or the
  // phase-2 apply — so an error past phase 1 never leaks an fd (issue #157).
  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      if (header === null) {
        // parseHeader runs the dimension check BEFORE any mutation (still true:
        // nothing is mutated in this phase at all).
        header = parseHeader(line, store);
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
        declaredSessionIds.add(s.externalId);
        sessionLines.push(s);
      } else if (record.t === 'obs') {
        const o = record as ObservationLine;
        if (!declaredSessionIds.has(o.sessionExternalId)) {
          throw new Error(
            `invalid export artifact: observation references unknown session '${o.sessionExternalId}'`,
          );
        }
        observationLines.push(o);
      }
      // Unknown line type: ignore for forward-compatibility within the same version.
    }

    if (header === null) {
      // No header line was ever seen. Nothing was mutated, so a `replace` against
      // an empty/header-less file leaves the store untouched.
      throw new Error('invalid export artifact: file is empty or has no header');
    }

    // Reconcile parsed rows against the header counts (F3-02). A truncated artifact
    // — fewer data lines than the header declares — must be rejected loudly, not
    // imported as a partial success. (Forward-compat unknown line types are ignored
    // above, so an over-count from those is not treated as truncation.)
    if (observationLines.length < header.counts.observations) {
      throw new Error(
        `export artifact truncated: header declares ${header.counts.observations} observations, found ${observationLines.length}`,
      );
    }
    if (sessionLines.length < header.counts.sessions) {
      throw new Error(
        `export artifact truncated: header declares ${header.counts.sessions} sessions, found ${sessionLines.length}`,
      );
    }

    // ---------------------------------------------------------------- PHASE 2
    // Apply everything atomically. `store.transaction` runs the closure inside a
    // single better-sqlite3 transaction that rolls back wholesale on any throw, so
    // a mid-apply failure leaves the store at its exact pre-import state (F3-01).
    const apply = store.transaction((): ImportResult => {
      if (mode === 'replace') wipe(store);

      const sessionIdByExternalId = new Map<string, number>();
      let sessionsImported = 0;
      let observationsImported = 0;

      for (const s of sessionLines) {
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
      }

      for (const o of observationLines) {
        const sessionId = sessionIdByExternalId.get(o.sessionExternalId);
        if (sessionId === undefined) {
          // Unreachable: parse phase already proved every obs references a declared
          // session, and every declared session is created/reused above. Guarded so
          // a future change can't slip a dangling insert past the transaction.
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

      return { sessionsImported, observationsImported };
    });

    return apply();
  } finally {
    rl.close();
  }
}
