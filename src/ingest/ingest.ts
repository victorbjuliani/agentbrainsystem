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
import { createReadStream, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Memory } from '../memory.js';
import { projectSlug } from '../optimize/targets.js';
import { type ParsedEntry, parseLine, type ToolAnchorSeed } from './claude-jsonl.js';
import { createCodexLineParser } from './codex-jsonl.js';
import { createCopilotLineParser } from './copilot-jsonl.js';
import { parseGeminiChat } from './gemini-chat.js';
// W-R3-1: isCodexTranscript + namespacedExternalId are LEAF helpers in namespacing.ts.
// ingest.ts IMPORTS them (one direction); it does NOT define isCodexTranscript itself.
import {
  isCodexTranscript,
  isCopilotTranscript,
  isGeminiTranscript,
  namespacedExternalId,
} from './namespacing.js';
import { cleanupBindings, readBinding, type SessionBinding } from './session-binding.js';
import type { IngestOptions, IngestResult } from './types.js';

/** kv_meta key prefix for the per-file byte-offset cursor. */
const CURSOR_PREFIX = 'ingest:cursor:';

/** kv_meta cache of a Codex rollout's header `cwd`, keyed by transcript path (W4 resume). */
const CODEX_CWD_PREFIX = 'codex:cwd:';

/** kv_meta cache of a Copilot session's `session.context_changed` cwd, keyed by path (#69 resume). */
const COPILOT_CWD_PREFIX = 'ingest:copilot-cwd:';

/** kv_meta key prefix for the per-Gemini-file last-ingested message id (W-NEW-1 rewind-safe, #68). */
const GEMINI_LASTID_PREFIX = 'gemini:lastid:';

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

/**
 * Propagate the edit's anchors onto its sibling PROSE observation (#90), so the
 * narrative that recall actually surfaces (FTS lives on the prose, not the
 * edit-summary obs) carries the same freshness signal. FILE-LEVEL ONLY and
 * deduped by `(observationId, filePath)`: a turn with N edits to M distinct
 * files adds at most M anchors and never a symbol anchor — avoids double-counting
 * and the status skew symbol propagation would cause. The propagated claims flow
 * through the same sweep/heal as the edit's own, so a removed file flips BOTH the
 * prose and the edit obs stale together. Returns the number of anchors created.
 */
function propagateFileAnchors(
  memory: Memory,
  proseObsId: number,
  anchors: ToolAnchorSeed[],
): number {
  const seen = new Set(memory.store.getAnchorsForObservation(proseObsId).map((a) => a.filePath));
  let count = 0;
  for (const filePath of new Set(anchors.map((a) => a.filePath))) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    memory.store.createAnchor({ observationId: proseObsId, anchorKind: 'file', filePath });
    count++;
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
 * The real cwd for a Gemini chat file (C-NEW-1, #68). The chat JSON has no cwd;
 * Gemini stores it in `<…/tmp/<slug>>/.project_root`, one dir up from
 * `…/chats/<file>`. Returns the absolute cwd, or undefined when the marker is
 * missing/empty so the caller can fall back to the slug dir name (NEVER "chats").
 * Sync read — one tiny file, off the per-line hot loop.
 */
function readGeminiProjectRoot(absPath: string): string | undefined {
  try {
    const marker = join(dirname(dirname(absPath)), '.project_root');
    const cwd = readFileSync(marker, 'utf8').trim();
    return cwd.length > 0 ? cwd : undefined;
  } catch {
    return undefined; // ENOENT/EISDIR → fall back to the slug dir
  }
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

/** Per-run mutable counters shared by the two ingest paths (no logic drift). */
interface WriteTally {
  added: number;
  skipped: number;
  /** Anchors created — edit-seeded PLUS turn-scoped file anchors propagated onto sibling prose obs (#90). Informational count; nothing branches on it meaning "edit anchors only". */
  seeded: number;
}

/**
 * Resolve → index → seed one parsed entry under an ALREADY-namespaced externalId.
 * Both the Claude and Codex paths call this, so the resolveSession → indexer.write
 * → seedAnchors body is identical and cannot drift. The caller supplies the
 * namespaced external id (Claude bare, Codex `codex:<uuid>`) and the effective
 * project; this never re-derives the namespace.
 */
async function writeEntry(
  memory: Memory,
  sessionCache: Map<string, number>,
  bindingCache: Map<string, SessionBinding | null>,
  externalId: string,
  effectiveProject: string,
  entry: ParsedEntry,
  absPath: string,
  tally: WriteTally,
  turnProse: Map<string, number>,
): Promise<void> {
  const sessionId = resolveSession(
    memory,
    sessionCache,
    bindingCache,
    externalId,
    effectiveProject,
    entry.cwd,
  );
  // A `skip` binding excludes this session: write nothing — no session, no
  // observation, no anchors (#50). The cursor was already advanced by the caller.
  if (sessionId === null) {
    tally.skipped++;
    return;
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
  tally.added++;
  // Remember a textless-or-not PROSE obs by its turn key so a sibling edit can
  // back-propagate file anchors onto it (#90). Only the anchorless prose line is
  // a propagation target; the edit line seeds its own anchors below. Turn-scoped
  // strictly — keyed on `turnKey`, never session-wide; absent ⇒ never buffered.
  if (hasText && entry.turnKey && entry.toolAnchors.length === 0) {
    turnProse.set(entry.turnKey, obsId);
  }
  if (entry.toolAnchors.length > 0) {
    tally.seeded += seedAnchors(memory, obsId, entry.toolAnchors);
    // Back-propagate FILE-level anchors onto this turn's sibling prose obs, if one
    // was buffered for the same turn key (fail-open: missing key ⇒ skip silently).
    const proseObsId = entry.turnKey ? turnProse.get(entry.turnKey) : undefined;
    if (proseObsId !== undefined) {
      tally.seeded += propagateFileAnchors(memory, proseObsId, entry.toolAnchors);
    }
  }
}

/**
 * Ingest one file from its persisted cursor to EOF, indexing each new readable
 * turn. Streams line-by-line; advances the cursor by the byte length of every
 * line consumed (including its newline) so a later run resumes exactly here.
 * The cursor is persisted only after the file is fully drained, so a crash
 * mid-file simply re-reads from the last committed offset (at-least-once; the
 * observation table tolerates a re-read because we only advance on completion).
 *
 * One selector at the top routes Codex rollouts (path-classified) through the
 * Codex parser + `codex:` namespace; everything else stays the byte-for-byte
 * Claude path. Both paths share `writeEntry` and identical per-line cursor
 * accounting (`offset += Buffer.byteLength(line) + 1`), so they cannot drift.
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
  const tally: WriteTally = { added: 0, skipped: 0, seeded: 0 };
  // Turn-scoped buffer (#90): turnKey → its prose obs id, for back-propagating a
  // sibling edit's file anchors onto the anchorless narrative obs. Per file-ingest
  // run — never crosses files or sessions.
  const turnProse = new Map<string, number>();

  if (isGeminiTranscript(absPath)) {
    // Whole-file JSON, NOT line-delimited and NOT incremental: Gemini rewrites the
    // ENTIRE file on every message (append-only EXCEPT `/rewind`, which truncates).
    // A byte cursor is meaningless; re-ingest is gated by a persistent per-session
    // ID-ANCHORED watermark (W-NEW-1): we remember the LAST-ingested message `id`
    // and ingest everything AFTER it. If that id is gone (rewound past it), we
    // RE-SYNC from the start — at-least-once dup, but NEVER a silent drop. The
    // cursor is INTENTIONALLY never advanced for Gemini: `cursor(0) < size` always
    // re-enters this branch, and the id-watermark (not the byte cursor) gates dedup.
    const raw = await readFile(absPath, 'utf8');
    const entries = parseGeminiChat(raw, absPath);
    // C-NEW-1: the cwd is NOT in the chat JSON. Recover the REAL cwd from the
    // `.project_root` marker one dir up from `chats/`. Fallback = the slug dir
    // name (NEVER the literal "chats").
    const geminiCwd = readGeminiProjectRoot(absPath);
    const effectiveProject = geminiCwd
      ? projectSlug(geminiCwd)
      : basename(dirname(dirname(absPath)));
    // ID-anchored skip: find the last-ingested id in the CURRENT parse; start after it.
    const lastIdKey = `${GEMINI_LASTID_PREFIX}${absPath}`;
    const lastId = memory.store.getMeta(lastIdKey);
    let start = 0;
    if (lastId !== null) {
      const idx = entries.findIndex((e) => e.id === lastId);
      start = idx >= 0 ? idx + 1 : 0; // found → tail; NOT found → re-sync (rewound)
    }
    for (let i = start; i < entries.length; i++) {
      const entry = entries[i] as ParsedEntry;
      const externalId = namespacedExternalId('gemini', entry.sessionId);
      await writeEntry(
        memory,
        sessionCache,
        bindingCache,
        externalId,
        effectiveProject,
        entry,
        absPath,
        tally,
        turnProse,
      );
    }
    // Advance the watermark to the LAST entry's id (the new tail). On an unchanged
    // file `start === entries.length` → nothing written, id unchanged (idempotent).
    const tailId = entries.at(-1)?.id;
    if (tailId) memory.store.setMeta(lastIdKey, tailId);
    result.observationsAdded += tally.added;
    result.observationsSkipped += tally.skipped;
    result.anchorsSeeded += tally.seeded;
    return;
  }

  const stream = createReadStream(absPath, { start: startOffset, encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  if (isCopilotTranscript(absPath)) {
    // Copilot path (#69): append-mostly events.jsonl → stream PER-LINE with a BYTE
    // cursor exactly like Codex. The sessionId is the session-state dir UUID (so a
    // header-less mid-file resume still groups), and the `session.context_changed`
    // cwd is recovered from the kv_meta cache for a header-less tail. The rare
    // compaction/fork truncate (cursor > size) is handled UPSTREAM in
    // `ingestOneTranscript` (re-sync from 0), so this branch only ever sees a tail.
    const cwdHint = memory.store.getMeta(`${COPILOT_CWD_PREFIX}${absPath}`) ?? undefined;
    const parser = createCopilotLineParser(absPath, cwdHint);
    for await (const line of rl) {
      const entry = parser.pushLine(line);
      if (!entry) {
        tally.skipped++;
        continue;
      }
      const externalId = namespacedExternalId('copilot', entry.sessionId);
      const effectiveProject = entry.cwd ? projectSlug(entry.cwd) : project;
      await writeEntry(
        memory,
        sessionCache,
        bindingCache,
        externalId,
        effectiveProject,
        entry,
        absPath,
        tally,
        turnProse,
      );
    }
    const observedCwd = parser.observedCwd();
    if (observedCwd) memory.store.setMeta(`${COPILOT_CWD_PREFIX}${absPath}`, observedCwd);
  } else if (isCodexTranscript(absPath)) {
    // Codex path (W4): stream PER-LINE like Claude. The sessionId is the FILENAME
    // UUID (so a header-less mid-file resume still groups), and the header `cwd`
    // is recovered from the kv_meta cache for a header-less tail.
    const cwdHint = memory.store.getMeta(`${CODEX_CWD_PREFIX}${absPath}`) ?? undefined;
    const parser = createCodexLineParser(absPath, cwdHint);
    for await (const line of rl) {
      const entry = parser.pushLine(line);
      if (!entry) {
        tally.skipped++;
        continue;
      }
      const externalId = namespacedExternalId('codex', entry.sessionId);
      const effectiveProject = entry.cwd ? projectSlug(entry.cwd) : project;
      await writeEntry(
        memory,
        sessionCache,
        bindingCache,
        externalId,
        effectiveProject,
        entry,
        absPath,
        tally,
        turnProse,
      );
    }
    // Persist the header cwd this read observed (if the slice included a header),
    // so a later header-less resume still derives the right project.
    const observedCwd = parser.observedCwd();
    if (observedCwd) memory.store.setMeta(`${CODEX_CWD_PREFIX}${absPath}`, observedCwd);
  } else {
    for await (const line of rl) {
      const entry = parseLine(line);
      if (entry === null) {
        tally.skipped++;
        continue;
      }

      // The project is the session's real cwd (`entry.cwd`), NOT the Claude Code
      // storage dir name (`project`). The storage dir mis-buckets subagent
      // transcripts (which live under `<project>/<uuid>/subagents/`) as the literal
      // "subagents", and fragments one cwd stored under two dir encodings (old
      // space/underscore vs new all-hyphen) into two projects. The cwd is canonical.
      // Fall back to the storage dir name only for older lines that carry no cwd.
      const effectiveProject = entry.cwd ? projectSlug(entry.cwd) : project;
      const externalId = namespacedExternalId('claude-code', entry.sessionId); // = bare id
      await writeEntry(
        memory,
        sessionCache,
        bindingCache,
        externalId,
        effectiveProject,
        entry,
        absPath,
        tally,
        turnProse,
      );
    }
  }

  // Persist the EXACT byte offset consumed (start + bytes the stream actually read
  // to EOF), NOT a per-line `byteLength + 1` tally. The tally overshot by 1 on any
  // file without a trailing newline, leaving cursor === size + 1; the Copilot
  // `cursor > size` compaction guard then misfired every run → full re-sync →
  // duplicate observations (#88). bytesRead is exact regardless of a trailing
  // newline and even if the file grew mid-read.
  writeCursor(memory, absPath, startOffset + stream.bytesRead);
  result.observationsAdded += tally.added;
  result.observationsSkipped += tally.skipped;
  result.anchorsSeeded += tally.seeded;
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
  // Fallback project for lines with no cwd: the encoded dir name (the file's
  // immediate parent). The hot path derives the project from each line's cwd.
  // HOISTED above the `cursor >= size` skip so the Copilot compaction guard can
  // call ingestFile with it (the guard fires BEFORE the skip — a guard inside
  // ingestFile would be dead code, control never reaches it after a skip).
  const project = basename(dirname(absPath));
  const cursor = readCursor(memory, absPath);
  // Copilot compaction/fork guard (#69): events.jsonl is append-mostly with a
  // STRICT-PREFIX truncate on compaction/fork. After a truncate the persisted
  // cursor > size, which the `cursor >= size` skip below would treat as "nothing
  // new" and SILENTLY DROP the freshly appended tail. Detect that here and re-sync
  // from offset 0 — at-least-once (the retained overlap is re-ingested as dup
  // observations; the dedup-free store write is the accepted #67/#68 tolerance),
  // NEVER a silent drop. Byte cursor > size is the correct, sufficient detector
  // because the only non-append write is a prefix truncate.
  if (isCopilotTranscript(absPath) && cursor > size) {
    writeCursor(memory, absPath, 0);
    await ingestFile(memory, absPath, project, 0, result);
    result.filesProcessed++;
    return;
  }
  if (cursor >= size) {
    result.filesSkipped++; // nothing new since last run
    return;
  }
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
