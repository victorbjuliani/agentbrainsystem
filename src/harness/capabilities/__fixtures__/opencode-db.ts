/**
 * Temp-SQLite fixture builder for opencode.db (#72, Task 7).
 *
 * Creates the EXACT 3 tables of a live opencode store (verified against the
 * v1.15.10 .schema — session/message/part, full column lists) and exposes a
 * seedSession helper to insert a session with ordered text/non-text parts. Shared
 * across the Task 2 (SqliteTranscriptSource), Task 4 (CLI subcommands) and Task 5
 * (adapter) tests so the schema is asserted in ONE place (drift-proof). The builder
 * writes plain JSON into message.data / part.data exactly as opencode does.
 */
import Database from 'better-sqlite3';

/** A single part to seed under a message. `type` defaults to 'text'. */
export interface SeedPart {
  id: string;
  /** part.data.type — 'text' is prose; everything else is skipped by ingest. */
  type?: string;
  /** The prose (for text parts). */
  text?: string;
  /** part.time_created (epoch ms). Defaults to a monotonic counter. */
  time?: number;
}

/** One message (role + its parts) to seed under a session. */
export interface SeedMessage {
  id: string;
  /** message.data.role — 'user' | 'assistant' (default 'assistant'). */
  role?: string;
  /** message.time_created (epoch ms). */
  time?: number;
  parts: SeedPart[];
}

export interface SeedSessionInput {
  id: string;
  directory: string;
  projectId?: string;
  messages: SeedMessage[];
}

/** Create the exact 3 opencode tables on an open better-sqlite3 handle. */
export function createOpencodeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY, "project_id" text NOT NULL, "parent_id" text,
      "slug" text NOT NULL, "directory" text NOT NULL,
      "title" text NOT NULL, "version" text NOT NULL,
      "time_created" integer NOT NULL, "time_updated" integer NOT NULL,
      "time_compacting" integer, "time_archived" integer, "workspace_id" text,
      "path" text, "agent" text, "model" text
    );
    CREATE TABLE IF NOT EXISTS "message" (
      "id" text PRIMARY KEY, "session_id" text NOT NULL,
      "time_created" integer NOT NULL, "time_updated" integer NOT NULL,
      "data" text NOT NULL,
      FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS "part" (
      "id" text PRIMARY KEY, "message_id" text NOT NULL, "session_id" text NOT NULL,
      "time_created" integer NOT NULL, "time_updated" integer NOT NULL,
      "data" text NOT NULL,
      FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE
    );
  `);
}

/**
 * Build a temp opencode.db at `dbPath` and seed one or more sessions. Returns the
 * closed file path. Each session/message/part is inserted with monotonic
 * time_created so the canonical (time_created, id) ordering is deterministic.
 */
export function buildOpencodeDb(dbPath: string, sessions: SeedSessionInput[]): string {
  const db = new Database(dbPath);
  createOpencodeSchema(db);
  let clock = 1_000;
  const insSession = db.prepare(
    `INSERT INTO "session" (id, project_id, parent_id, slug, directory, title, version,
       time_created, time_updated, time_compacting, time_archived, workspace_id, path, agent, model)
     VALUES (@id,@projectId,NULL,@slug,@directory,@title,'1.15.10',@t,@t,NULL,NULL,NULL,NULL,NULL,NULL)`,
  );
  const insMessage = db.prepare(
    `INSERT INTO "message" (id, session_id, time_created, time_updated, data)
     VALUES (@id,@sessionId,@t,@t,@data)`,
  );
  const insPart = db.prepare(
    `INSERT INTO "part" (id, message_id, session_id, time_created, time_updated, data)
     VALUES (@id,@messageId,@sessionId,@t,@t,@data)`,
  );
  const tx = db.transaction((all: SeedSessionInput[]) => {
    for (const s of all) {
      const t = clock++;
      insSession.run({
        id: s.id,
        projectId: s.projectId ?? 'prj_test',
        slug: 'test-slug',
        directory: s.directory,
        title: 'test session',
        t,
      });
      for (const m of s.messages) {
        const mt = m.time ?? clock++;
        insMessage.run({
          id: m.id,
          sessionId: s.id,
          t: mt,
          data: JSON.stringify({
            role: m.role ?? 'assistant',
            path: { cwd: m.role === 'user' ? '' : s.directory, root: s.directory },
            modelID: 'glm-5.1',
            time: { created: mt },
          }),
        });
        for (const p of m.parts) {
          const pt = p.time ?? clock++;
          const type = p.type ?? 'text';
          const data: Record<string, unknown> = { type };
          if (type === 'text') data.text = p.text ?? '';
          insPart.run({
            id: p.id,
            messageId: m.id,
            sessionId: s.id,
            t: pt,
            data: JSON.stringify(data),
          });
        }
      }
    }
  });
  tx(sessions);
  db.close();
  return dbPath;
}

/** Append parts to an EXISTING message in an existing temp DB (incremental tests). */
export function appendParts(
  dbPath: string,
  sessionId: string,
  messageId: string,
  parts: SeedPart[],
  startTime: number,
): void {
  const db = new Database(dbPath);
  let t = startTime;
  const ins = db.prepare(
    `INSERT INTO "part" (id, message_id, session_id, time_created, time_updated, data)
     VALUES (@id,@messageId,@sessionId,@t,@t,@data)`,
  );
  const tx = db.transaction((ps: SeedPart[]) => {
    for (const p of ps) {
      const type = p.type ?? 'text';
      const data: Record<string, unknown> = { type };
      if (type === 'text') data.text = p.text ?? '';
      ins.run({ id: p.id, messageId, sessionId, t: t++, data: JSON.stringify(data) });
    }
  });
  tx(parts);
  db.close();
}

/** Delete a part by id (rewind/compaction test). */
export function deletePart(dbPath: string, partId: string): void {
  const db = new Database(dbPath);
  db.prepare('DELETE FROM "part" WHERE id = ?').run(partId);
  db.close();
}
