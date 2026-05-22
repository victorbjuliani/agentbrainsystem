/**
 * Session→project decision binding (#50) — the durable record of an intentional
 * choice about which project a Claude Code session is filed under, or whether to
 * skip the session entirely.
 *
 * Stored in the existing `kv_meta` key/value table (NO schema migration), keyed
 * by the Claude Code `session_id`. Spike #49 proved that id equals the transcript
 * line's `sessionId` (the value ingest groups by), so a binding written here is
 * matched whenever ingest next runs — even if `SessionEnd` never fired (#49 also
 * proved `SessionEnd` is not guaranteed on abrupt Ctrl-C / kill). The binding is
 * the at-least-once carrier of the decision; ingest is decision-aware at its
 * `resolveSession` choke point.
 *
 * Decision shapes:
 *   - `set`  → override the auto-derived project with a sanitized label.
 *   - `skip` → never store this session (and reconcile any already-stored rows).
 *
 * Untrusted input: the project label originates from the CLI (#51) / MCP tool
 * (#52). It is sanitized at the write boundary and treated as an opaque single-
 * line label downstream (delete/export/recall/UI all compare it as a literal
 * string — never as a path).
 */
import type { MemoryStore } from '../store/index.js';

/** kv_meta key prefix for a session→project binding (keyed by externalId). */
export const BINDING_PREFIX = 'session-project:';

/**
 * A `set` binding expires after this window (a one-shot override is safe to
 * forget once applied). A `skip` binding is PERMANENT — it expresses "never store
 * this session", so it must outlive an arbitrarily long-lived/resumed session and
 * is never auto-expired here. (Orphan-skip housekeeping is deferred — see #50.)
 */
export const SET_BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Max length of a sanitized project label. */
const MAX_PROJECT_NAME = 100;

/** The user's intentional decision for a session. */
export type SessionBinding =
  | { action: 'set'; project: string; createdAt: string }
  | { action: 'skip'; createdAt: string };

/** A new decision passed to {@link writeBinding}. */
export type BindingDecision = { action: 'set'; project: string } | { action: 'skip' };

/** The on-disk JSON shape (all fields optional — read defensively, never throw). */
interface StoredBinding {
  action?: string;
  project?: string;
  createdAt?: string;
}

function bindingKey(externalId: string): string {
  return `${BINDING_PREFIX}${externalId}`;
}

/**
 * Sanitize an untrusted project label. Returns a safe, single-line label or
 * `null` when nothing usable remains (the caller must then NOT write a binding).
 * Rules: control chars and newlines → space; path separators → dash (the label is
 * never a path); collapse whitespace; trim; cap length.
 */
export function sanitizeProjectName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent.
  let s = raw.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s.replace(/[/\\]+/g, '-'); // path separators -> dash (never a filesystem path)
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length === 0) return null;
  if (s.length > MAX_PROJECT_NAME) s = s.slice(0, MAX_PROJECT_NAME).trim();
  return s.length > 0 ? s : null;
}

function isExpired(createdAt: string | undefined, now: Date): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return false; // unparseable → never expire (safe default)
  return now.getTime() - t > SET_BINDING_TTL_MS;
}

/**
 * Write a decision binding for a session. Returns whether a binding was written.
 *  - `set`: sanitizes the project name; if it sanitizes to nothing, writes nothing
 *    (a no-op rather than persisting a junk binding) and returns `false`.
 *  - `skip`: reconciles immediately — if a session row already exists for this
 *    externalId (e.g. it was fully ingested before the user decided to skip), it
 *    is deleted now (cascade prunes observations + vec/fts + anchors). Ingest's
 *    in-loop skip covers the not-yet / still-ingesting orderings; this covers the
 *    already-fully-ingested ordering, whose file cursor is at EOF so ingest would
 *    otherwise never revisit it. The `skip` binding is still persisted so future
 *    appended lines (a resume) keep being skipped.
 */
export function writeBinding(
  store: MemoryStore,
  externalId: string,
  decision: BindingDecision,
  now: Date = new Date(),
): boolean {
  const createdAt = now.toISOString();
  if (decision.action === 'set') {
    const project = sanitizeProjectName(decision.project);
    if (project === null) return false;
    store.setMeta(bindingKey(externalId), JSON.stringify({ action: 'set', project, createdAt }));
    return true;
  }
  const existing = store.getSessionByExternalId(externalId);
  if (existing) store.deleteSession(existing.id);
  store.setMeta(bindingKey(externalId), JSON.stringify({ action: 'skip', createdAt }));
  return true;
}

/**
 * Read the decision binding for a session, or `null` when absent, expired, or
 * malformed. A `set` binding older than {@link SET_BINDING_TTL_MS} is lazily
 * expired (deleted, returns `null`); a `set` binding with an empty/missing project
 * is treated as absent (defensive). `skip` bindings never expire. Never throws.
 */
export function readBinding(
  store: MemoryStore,
  externalId: string,
  now: Date = new Date(),
): SessionBinding | null {
  const raw = store.getMeta(bindingKey(externalId));
  if (raw === null) return null;
  let parsed: StoredBinding;
  try {
    parsed = JSON.parse(raw) as StoredBinding;
  } catch {
    return null;
  }
  if (parsed.action === 'skip') {
    return { action: 'skip', createdAt: parsed.createdAt ?? now.toISOString() };
  }
  if (parsed.action === 'set') {
    const project = typeof parsed.project === 'string' ? parsed.project : '';
    if (project.length === 0) return null;
    if (isExpired(parsed.createdAt, now)) {
      store.deleteMeta(bindingKey(externalId));
      return null;
    }
    return { action: 'set', project, createdAt: parsed.createdAt ?? now.toISOString() };
  }
  return null;
}

/**
 * Drop expired `set` bindings (housekeeping; called once per ingest run). `skip`
 * bindings are permanent and never removed here. PK-range scan via `listMetaKeys`.
 * Returns the number removed.
 */
export function cleanupBindings(store: MemoryStore, now: Date = new Date()): number {
  let removed = 0;
  for (const key of store.listMetaKeys(BINDING_PREFIX)) {
    const raw = store.getMeta(key);
    if (raw === null) continue;
    let parsed: StoredBinding;
    try {
      parsed = JSON.parse(raw) as StoredBinding;
    } catch {
      continue;
    }
    if (parsed.action === 'set' && isExpired(parsed.createdAt, now)) {
      store.deleteMeta(key);
      removed++;
    }
  }
  return removed;
}
