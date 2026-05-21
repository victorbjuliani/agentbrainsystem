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
import { parseLine, type ToolAnchorSeed } from './claude-jsonl.js';
import type { IngestOptions, IngestResult } from './types.js';

/** kv_meta key prefix for the per-file byte-offset cursor. */
const CURSOR_PREFIX = 'ingest:cursor:';

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
 * Look up (or lazily create) the store session for a Claude Code `sessionId`,
 * caching the resolution so we touch the store once per session per run.
 * `project` is the encoded project dir name (stable across machines for a repo);
 * `cwd` is kept on the session meta as a human-readable hint.
 */
function resolveSession(
  memory: Memory,
  cache: Map<string, number>,
  externalId: string,
  project: string,
  cwd: string | undefined,
): number {
  const cached = cache.get(externalId);
  if (cached !== undefined) return cached;

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

    const sessionId = resolveSession(memory, sessionCache, entry.sessionId, project, entry.cwd);
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

/**
 * Ingest every Claude Code transcript under the projects root, incrementally.
 * Re-running is safe: files whose cursor already covers their current size are
 * skipped; grown files resume from the cursor.
 */
export async function ingestClaudeProjects(
  memory: Memory,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const root = options.projectsDir ?? defaultClaudeProjectsDir();
  const result: IngestResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    observationsAdded: 0,
    observationsSkipped: 0,
    anchorsSeeded: 0,
  };

  for await (const absPath of walkJsonlFiles(root)) {
    let size: number;
    try {
      size = (await stat(absPath)).size;
    } catch {
      continue; // vanished between walk and stat — ignore
    }

    const cursor = readCursor(memory, absPath);
    if (cursor >= size) {
      result.filesSkipped++; // nothing new since last run
      continue;
    }

    // The encoded project dir name is the immediate parent of the file.
    const project = basename(dirname(absPath));
    await ingestFile(memory, absPath, project, cursor, result);
    result.filesProcessed++;
  }

  return result;
}
