/**
 * Incremental ingestion of Claude Code transcripts into the memory store (issue #7).
 *
 * Walks `~/.claude/projects/**\/*.jsonl`, streams each file line-by-line, and
 * turns each readable conversation turn into an indexed observation via
 * `indexer.write` (index-at-write — nothing lands unindexed). One store session
 * per Claude Code `sessionId`.
 *
 * Footprint discipline (ADR 0001):
 *   - files are streamed via `node:readline` over a `createReadStream`; we never
 *     read a whole file or the whole tree into memory.
 *   - files are processed one at a time, sequentially.
 *
 * Incrementality: each file's progress is a **byte offset** persisted in
 * `kv_meta` under `ingest:cursor:<absPath>`. A re-run resumes from that offset
 * (skipping a file whose size has not grown), so already-seen lines are never
 * re-ingested. Counting bytes rather than lines lets us resume from a precise
 * `createReadStream({ start })` without rescanning the prefix.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Memory } from '../memory.js';
import { projectSlug } from '../optimize/targets.js';
import { parseLine, type ToolAnchorSeed } from './claude-jsonl.js';
import { cleanupBindings, readBinding, type SessionBinding } from './session-binding.js';
import type { IngestOptions, IngestResult } from './types.js';

/** kv_meta key prefix for the per-file byte-offset cursor. */
const CURSOR_PREFIX = 'ingest:cursor:';

/** Per-run session-cache sentinel marking a session a `skip` binding excludes. */
const SKIP = -1;

/**
 * A one-line, footprint-cheap summary for an edit-only turn (no prose), so the
 * seeded anchor has a home observation and the edit is a recallable fact. We
 * never store the diff — only "which tools touched which files".
 */
function summarizeEdits(anchors: ToolAnchorSeed[]): string {
  const files = [...new Set(anchors.map((a) => `${a.tool} ${a.filePath}`))];
  return files.join('; ');
}

/**
 * Seed `claimed` fact anchors for one observation from its Edit/Write tool
 * calls: one file-level anchor per distinct file, plus one symbol-level anchor
 * per symbol the payload defined. The sweep (#26) later resolves these against
 * ground truth. Returns the number of anchors created.
 */
function seedAnchors(memory: Memory, observationId: number, anchors: ToolAnchorSeed[]): number {
  let count = 0;
  for (const a of anchors) {
    memory.store.createAnchor({ observationId, anchorKind: 'file', filePath: a.filePath });
    count++;
    for (const symbol of a.symbols) {
      memory.store.createAnchor({
        observationId,
        anchorKind: 'symbol',
        qualifiedName: symbol,
        filePath: a.filePath,
      });
      count++;
    }
  }
  return count;
}

/** Default Claude Code projects root, resolved cross-platform via os/path. */
export function defaultClaudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Recursively yield every `*.jsonl` file path under `root` (depth-first, lazy). */
async function* walkJsonlFiles(root: string): AsyncGenerator<string> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // missing/unreadable dir — nothing to yield
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonlFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield full;
    }
  }
}

function readCursor(memory: Memory, absPath: string): number {
  const raw = memory.store.getMeta(`${CURSOR_PREFIX}${absPath}`);
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function writeCursor(memory: Memory, absPath: string, offset: number): void {
  memory.store.setMeta(`${CURSOR_PREFIX}${absPath}`, String(offset));
}

/**
 * Read the session→project binding once per externalId per run (mirrors the
 * session cache so a binding lookup is one `kv_meta` read per session, not per
 * line). Caches the `null` (no-binding) result too.
 */
function resolveBinding(
  cache: Map<string, SessionBinding | null>,
  memory: Memory,
  externalId: string,
): SessionBinding | null {
  const cached = cache.get(externalId);
  if (cached !== undefined) return cached;
  const binding = readBinding(memory.store, externalId);
  cache.set(externalId, binding);
  return binding;
}

/**
 * Resolve the store session id for a Claude Code `sessionId`, applying any
 * intentional decision binding (#50). Returns `null` when the session is bound
 * `skip` (the caller skips the line — advancing the cursor but writing nothing).
 *
 * Caching keeps this one store touch per session per run:
 *   - `skip`  → reconcile any session created in a prior run (delete, cascade),
 *     then cache the SKIP sentinel so every subsequent line short-circuits.
 *   - `set X` → upsert the project (UPDATE-safe), overriding an auto-derived
 *     project even if a prior run already created the row (Risk #2).
 *   - none    → byte-for-byte the original behavior (look up or create with the
 *     cwd-derived project) — zero regression.
 */
function resolveSession(
  memory: Memory,
  cache: Map<string, number>,
  bindingCache: Map<string, SessionBinding | null>,
  externalId: string,
  project: string,
  cwd: string | undefined,
): number | null {
  const cached = cache.get(externalId);
  if (cached !== undefined) return cached === SKIP ? null : cached;

  const binding = resolveBinding(bindingCache, memory, externalId);

  if (binding?.action === 'skip') {
    const existing = memory.store.getSessionByExternalId(externalId);
    if (existing) memory.store.deleteSession(existing.id);
    cache.set(externalId, SKIP);
    return null;
  }

  if (binding?.action === 'set') {
    // Carry the cwd hint on the create-on-miss path so a `set` binding that fires
    // before the first ingest still records `meta.cwd` like the normal create.
    const id = memory.store.setSessionProject(
      externalId,
      binding.project,
      cwd ? { cwd } : undefined,
    );
    cache.set(externalId, id);
    return id;
  }

  const existing = memory.store.getSessionByExternalId(externalId);
  if (existing) {
    cache.set(externalId, existing.id);
    return existing.id;
  }

  const id = memory.store.createSession({
    externalId,
    project,
    meta: cwd ? { cwd } : undefined,
  });
  cache.set(externalId, id);
  return id;
}

/**
 * Ingest one file from its persisted cursor to EOF, indexing each new readable
 * turn. Streams line-by-line; advances the cursor by the byte length of every
 * line consumed (including its newline) so a later run resumes exactly here.
 * The cursor is persisted only after the file is fully drained, so a crash
 * mid-file simply re-reads from the last committed offset (at-least-once; the
 * observation table tolerates a re-read because we only advance on completion).
 */
async function ingestFile(
  memory: Memory,
  absPath: string,
  project: string,
  startOffset: number,
  result: IngestResult,
): Promise<void> {
  const sessionCache = new Map<string, number>();
  const bindingCache = new Map<string, SessionBinding | null>();
  let offset = startOffset;
  let added = 0;
  let skipped = 0;
  let seeded = 0;

  const stream = createReadStream(absPath, { start: startOffset, encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of rl) {
    // Advance the byte cursor by the raw line + the newline readline stripped.
    // (A trailing line without a newline overshoots by 1; harmless — EOF anyway.)
    offset += Buffer.byteLength(line, 'utf8') + 1;

    const entry = parseLine(line);
    if (entry === null) {
      skipped++;
      continue;
    }

    // The project is the session's real cwd (`entry.cwd`), NOT the Claude Code
    // storage dir name (`project`). The storage dir mis-buckets subagent
    // transcripts (which live under `<project>/<uuid>/subagents/`) as the literal
    // "subagents", and fragments one cwd stored under two dir encodings (old
    // space/underscore vs new all-hyphen) into two projects. The cwd is canonical.
    // Fall back to the storage dir name only for older lines that carry no cwd.
    const effectiveProject = entry.cwd ? projectSlug(entry.cwd) : project;
    const sessionId = resolveSession(
      memory,
      sessionCache,
      bindingCache,
      entry.sessionId,
      effectiveProject,
      entry.cwd,
    );
    // A `skip` binding excludes this session: advance the cursor (done above) but
    // write nothing — no session, no observation, no anchors (#50).
    if (sessionId === null) {
      skipped++;
      continue;
    }
    // Prose turn → store the text under its role. Edit-only turn (no prose) →
    // store a compact 'tool_edit' summary so the seeded anchor has a home.
    const hasText = entry.text.length > 0;
    const obsId = await memory.indexer.write({
      sessionId,
      kind: hasText ? entry.role : 'tool_edit',
      content: hasText ? entry.text : summarizeEdits(entry.toolAnchors),
      source: absPath,
      ...(entry.timestamp ? { createdAt: entry.timestamp } : {}),
      ...(entry.uuid ? { metadata: { uuid: entry.uuid } } : {}),
    });
    added++;
    if (entry.toolAnchors.length > 0) {
      seeded += seedAnchors(memory, obsId, entry.toolAnchors);
    }
  }

  writeCursor(memory, absPath, offset);
  result.observationsAdded += added;
  result.observationsSkipped += skipped;
  result.anchorsSeeded += seeded;
}

/** A fresh zeroed tally. */
function emptyResult(): IngestResult {
  return {
    filesProcessed: 0,
    filesSkipped: 0,
    observationsAdded: 0,
    observationsSkipped: 0,
    anchorsSeeded: 0,
  };
}

/**
 * Ingest a single transcript file (cursor-aware), tallying into `result`. A vanished
 * file is a no-op; a file whose cursor already covers its size is counted skipped.
 */
async function ingestOneTranscript(
  memory: Memory,
  absPath: string,
  result: IngestResult,
): Promise<void> {
  let size: number;
  try {
    size = (await stat(absPath)).size;
  } catch {
    return; // vanished between walk and stat — ignore
  }
  const cursor = readCursor(memory, absPath);
  if (cursor >= size) {
    result.filesSkipped++; // nothing new since last run
    return;
  }
  // Fallback project for lines with no cwd: the encoded dir name (the file's
  // immediate parent). The hot path derives the project from each line's cwd.
  const project = basename(dirname(absPath));
  await ingestFile(memory, absPath, project, cursor, result);
  result.filesProcessed++;
}

/**
 * Ingest every Claude Code transcript under the projects root, incrementally.
 * Re-running is safe: files whose cursor already covers their current size are
 * skipped; grown files resume from the cursor.
 *
 * EXPLICIT/opt-in (#62): this walks the WHOLE tree, so it is only ever run by the
 * user via `abs ingest`, never automatically. `options.projects` restricts the walk
 * to those project slugs (the file's parent-dir name) so the user can pull just the
 * projects they want — the rest of the on-disk history is left untouched.
 */
export async function ingestClaudeProjects(
  memory: Memory,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const root = options.projectsDir ?? defaultClaudeProjectsDir();
  const result = emptyResult();
  const filter = options.projects ? new Set(options.projects) : null;

  // Housekeeping: drop expired `set` bindings once per run (`skip` is permanent).
  cleanupBindings(memory.store);

  for await (const absPath of walkJsonlFiles(root)) {
    if (filter && !filter.has(basename(dirname(absPath)))) continue;
    await ingestOneTranscript(memory, absPath, result);
  }

  return result;
}

/**
 * Ingest ONLY the given session's transcript file (#62). This is what the SessionEnd
 * hook calls: it scopes auto-ingest to the just-finished session, so a fresh/reset
 * store is never silently back-filled with the machine's whole transcript history
 * (that is now an explicit `abs ingest` action). Cursor-aware like the full walk.
 */
export async function ingestSingleSession(
  memory: Memory,
  transcriptPath: string,
): Promise<IngestResult> {
  const result = emptyResult();
  // Same once-per-run housekeeping as the full walk.
  cleanupBindings(memory.store);
  await ingestOneTranscript(memory, transcriptPath, result);
  return result;
}

/** Per-project availability, for the `abs ingest` preview. No writes. */
export interface ProjectSurvey {
  /** Project slug (the transcript file's parent-dir name). */
  project: string;
  /** Total transcript files found for this project. */
  transcripts: number;
  /** Files with content past the stored cursor (i.e. something new to ingest). */
  newTranscripts: number;
}

/**
 * Survey the on-disk transcripts grouped by project WITHOUT writing anything (#62).
 * Powers the `abs ingest` preview: the user sees which projects exist and how much
 * is new before choosing what to ingest. Reads cursors to compute `newTranscripts`.
 */
export async function surveyClaudeProjects(
  memory: Memory,
  options: IngestOptions = {},
): Promise<ProjectSurvey[]> {
  const root = options.projectsDir ?? defaultClaudeProjectsDir();
  const filter = options.projects ? new Set(options.projects) : null;
  const byProject = new Map<string, { transcripts: number; newTranscripts: number }>();

  for await (const absPath of walkJsonlFiles(root)) {
    const project = basename(dirname(absPath));
    if (filter && !filter.has(project)) continue;
    let size: number;
    try {
      size = (await stat(absPath)).size;
    } catch {
      continue;
    }
    const entry = byProject.get(project) ?? { transcripts: 0, newTranscripts: 0 };
    entry.transcripts++;
    if (readCursor(memory, absPath) < size) entry.newTranscripts++;
    byProject.set(project, entry);
  }

  return [...byProject.entries()]
    .map(([project, v]) => ({ project, ...v }))
    .sort((a, b) => a.project.localeCompare(b.project));
}
