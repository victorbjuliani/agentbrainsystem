/**
 * SqliteTranscriptSource (#72, Task 2) — the OpenCode capture capability.
 *
 * OpenCode is the most architecturally divergent harness: history lives in a
 * relational SQLite store (~/.local/share/opencode/opencode.db, tables
 * session/message/part), NOT a per-session JSONL/JSON transcript file. So this
 * capability REPLACES the `jsonlTranscriptSource` + `ingestSingleSession(path)`
 * model for OpenCode: it reads ONE session by id from the DB and writes its prose
 * through the existing indexer.
 *
 * Watermark (at-least-once, id-anchored — the #67/#68/#69 dup class). `session.idle`
 * re-fires on a growing session, so we MUST NOT re-read all parts each time. We
 * remember the LAST-ingested `part.id` per session in `kv_meta` and ingest only the
 * parts AFTER it. If that id is GONE (history compacted/rewound past it →
 * `session.compacted`), we RE-SYNC from the start — an at-least-once dup is the
 * accepted #67/#68 store tolerance (`createObservation` is a plain INSERT, no
 * ON CONFLICT), but NEVER a silent drop. This is the EXACT discipline of the Gemini
 * `GEMINI_LASTID_PREFIX` watermark (`ingest.ts:317-342`), translated from "message
 * id in a parsed JSON array" to "part id in a SQL result set".
 *
 * Read-only / WAL-safe: the DB is opened `{ readonly: true, fileMustExist: true }`
 * with `PRAGMA query_only = 1`; opencode keeps writing during a live session and a
 * read-only handle tolerates concurrent WAL writers. We NEVER write to opencode.db.
 *
 * cwd source: ALWAYS `session.directory` (canonical) — `message.data.path.cwd` is
 * EMPTY on user messages, so it cannot be trusted.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { namespacedExternalId } from '../../ingest/namespacing.js';
import { readBinding } from '../../ingest/session-binding.js';
import type { IngestResult } from '../../ingest/types.js';
import type { Memory } from '../../memory.js';
import { projectSlug } from '../../optimize/targets.js';

/** kv_meta key prefix for the per-session id watermark (last-ingested part.id). */
const CURSOR_PREFIX = 'opencode:cursor:';

export interface SqliteTranscriptSourceOptions {
  /** Override the opencode.db path (defaults to the live store). Mainly for tests. */
  dbPath?: string;
}

export interface SqliteTranscriptSource {
  ingestSession(memory: Memory, sessionId: string): Promise<IngestResult>;
}

interface PartRow {
  part_id: string;
  p_time: number;
  p_data: string;
  msg_id: string;
  m_time: number;
  m_data: string;
  directory: string;
}

function defaultDbPath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

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
 * Resolve the store session id for an opencode session, honoring an intentional
 * `skip`/`set` decision binding (the same machinery the file-ingest path uses).
 * Returns null when the session is bound `skip` (write nothing). The externalId is
 * ALREADY namespaced (`opencode:<ses>`).
 */
function resolveStoreSession(
  memory: Memory,
  externalId: string,
  project: string,
  cwd: string,
): number | null {
  const binding = readBinding(memory.store, externalId);

  if (binding?.action === 'skip') {
    const existing = memory.store.getSessionByExternalId(externalId);
    if (existing) memory.store.deleteSession(existing.id);
    return null;
  }
  if (binding?.action === 'set') {
    return memory.store.setSessionProject(externalId, binding.project, { cwd });
  }
  const existing = memory.store.getSessionByExternalId(externalId);
  if (existing) return existing.id;
  return memory.store.createSession({ externalId, project, meta: { cwd } });
}

export function sqliteTranscriptSource(
  options: SqliteTranscriptSourceOptions = {},
): SqliteTranscriptSource {
  const dbPath = options.dbPath ?? defaultDbPath();
  return {
    async ingestSession(memory: Memory, sessionId: string): Promise<IngestResult> {
      const result = emptyResult();
      let db: Database.Database;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch {
        // Vanished / unreadable DB → fail-open, ingest nothing.
        return result;
      }
      try {
        db.pragma('query_only = 1');
        const rows = db
          .prepare(
            `SELECT p.id AS part_id, p.time_created AS p_time, p.data AS p_data,
                    m.id AS msg_id, m.time_created AS m_time, m.data AS m_data,
                    s.directory AS directory
             FROM part p
             JOIN message m ON m.id = p.message_id
             JOIN session s ON s.id = p.session_id
             WHERE p.session_id = ?
             ORDER BY p.time_created ASC, p.id ASC`,
          )
          .all(sessionId) as PartRow[];

        if (rows.length === 0) return result;

        const externalId = namespacedExternalId('opencode', sessionId);
        const cwd = rows[0]?.directory ?? '';
        const project = projectSlug(cwd);

        // Watermark: start AFTER the last-ingested part.id; if it is gone (rewound),
        // re-sync from index 0 (at-least-once dup, NEVER a silent drop — same as Gemini).
        const cursorKey = `${CURSOR_PREFIX}${sessionId}`;
        const lastId = memory.store.getMeta(cursorKey);
        let start = 0;
        if (lastId !== null) {
          const idx = rows.findIndex((r) => r.part_id === lastId);
          start = idx >= 0 ? idx + 1 : 0; // found → tail; NOT found → re-sync (rewound)
        }

        let storeSessionId: number | null | undefined;
        let lastTextPartId: string | null = null;

        for (let i = start; i < rows.length; i++) {
          const row = rows[i] as PartRow;
          let pData: { type?: string; text?: string };
          try {
            pData = JSON.parse(row.p_data);
          } catch {
            result.observationsSkipped++;
            continue;
          }
          const text = pData.type === 'text' ? (pData.text ?? '').trim() : '';
          if (!text) {
            result.observationsSkipped++; // reasoning/tool/patch/step-* (v1 skip)
            continue;
          }
          // Resolve the store session lazily on the first writable part (a skip
          // binding short-circuits the whole session).
          if (storeSessionId === undefined) {
            storeSessionId = resolveStoreSession(memory, externalId, project, cwd);
          }
          if (storeSessionId === null) {
            result.observationsSkipped++;
            continue;
          }
          let role = 'assistant';
          let createdAt: string | undefined;
          try {
            const mData = JSON.parse(row.m_data) as { role?: string };
            if (mData.role) role = mData.role;
          } catch {
            /* default role */
          }
          // Stamp from the PART time, not the message time: parts of one message are
          // emitted at different times, and m_time would collapse them to one instant,
          // distorting activity ordering (MAX(observations.created_at)) and making later
          // chunks look older (#90c). p_time is already fetched.
          if (typeof row.p_time === 'number') createdAt = new Date(row.p_time).toISOString();
          await memory.indexer.write({
            sessionId: storeSessionId,
            kind: role,
            content: text,
            source: `opencode:${sessionId}`,
            ...(createdAt ? { createdAt } : {}),
          });
          result.observationsAdded++;
          lastTextPartId = row.part_id;
        }

        // Advance the watermark to the LAST text part ingested this run. If nothing
        // new was written, leave it unchanged (idempotent on an unchanged session).
        if (lastTextPartId !== null) memory.store.setMeta(cursorKey, lastTextPartId);
        return result;
      } finally {
        db.close();
      }
    },
  };
}
