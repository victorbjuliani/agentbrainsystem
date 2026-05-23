/**
 * GitHub Copilot CLI events.jsonl transcript parsing (#69).
 *
 * Copilot writes `~/.copilot/session-state/<sessionId>/events.jsonl` —
 * append-mostly JSON-Lines, one event object per line. Unlike Claude Code, the
 * session id is NOT on every line; it is the `<uuid>` PARENT-DIR name (which equals
 * the hook payload `session_id`), so we derive it from the path — exactly like
 * Codex derives it from the rollout filename.
 *
 * Per-event envelope: `{ id, timestamp, parentId, ephemeral, agentId, type, data }`.
 * Conversation prose lives in `user.message` / `assistant.message` events whose
 * `data.content` is a plain string. The cwd is NOT on the message events; it rides
 * the `session.context_changed` event's `data.cwd` (the Codex pattern — cwd in a
 * header-ish event, cached in kv_meta for header-less tail resumes). Streaming
 * `assistant.message_delta` events are ignored — we ingest only finalized
 * `*.message` turns. `ephemeral:true` events are never persisted to the file, so
 * the parser never sees them.
 *
 * Tool anchors are mined best-effort from `assistant.message.data.toolRequests[]`
 * (`{ name, arguments:{ file_path, content|new_string } }`); the exact element
 * schema is a Task-8 (authed-run) unverified item, so an unrecognized shape
 * degrades to `[]` rather than throwing.
 *
 * Never throws: a malformed / blank / non-conversation line is a skip.
 */
import { normalizeWorktreePath, type ParsedEntry, type ToolAnchorSeed } from './claude-jsonl.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Source-file extensions whose Write/Edit we try to anchor (mirrors claude-jsonl). */
const CODE_EXTENSIONS = new Set([
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.sql',
  '.vue',
  '.svelte',
  '.go',
  '.rs',
]);
function hasCodeExtension(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 && CODE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}
const SYMBOL_DEF =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:def|function|class|const|func|type|interface)\s+([A-Za-z_]\w+)/g;
function extractSymbols(payload: string): string[] {
  const out = new Set<string>();
  for (const m of payload.matchAll(SYMBOL_DEF)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

const INJECTED_WRAPPER =
  /<(system-reminder|command-name|command-message|command-args|command-contents|local-command-stdout|local-command-caveat|INSTRUCTIONS)>[\s\S]*?<\/\1>/g;
function clean(text: string): string {
  return text
    .replace(INJECTED_WRAPPER, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract the session UUID from a `.../session-state/<uuid>/events.jsonl` path —
 * the PARENT-DIR name (the Copilot session id, equal to the hook `session_id`).
 */
function sessionIdFromPath(path: string): string | undefined {
  const m = path.match(
    /\/session-state\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/events\.jsonl$/i,
  );
  return m?.[1];
}

/**
 * Best-effort Edit/Write anchor mining from `assistant.message.data.toolRequests`.
 * Each element is `{ name, arguments:{ file_path, content|new_string } }`. Anything
 * that doesn't match (non-array, missing path, non-code file) degrades to no anchor.
 */
function extractCopilotAnchors(toolRequests: unknown): ToolAnchorSeed[] {
  if (!Array.isArray(toolRequests)) return [];
  const seeds: ToolAnchorSeed[] = [];
  for (const req of toolRequests) {
    if (!isRecord(req)) continue;
    const tool = asString(req.name);
    if (tool !== 'Edit' && tool !== 'Write') continue;
    const args = isRecord(req.arguments) ? req.arguments : undefined;
    const rawPath = args ? asString(args.file_path) : undefined;
    if (!rawPath || !hasCodeExtension(rawPath)) continue;
    const filePath = normalizeWorktreePath(rawPath);
    const payload = args ? (asString(args.new_string) ?? asString(args.content) ?? '') : '';
    seeds.push({ tool, filePath, symbols: extractSymbols(payload) });
  }
  return seeds;
}

/** A stateful per-line Copilot parser (the Codex template). */
export interface CopilotLineParser {
  pushLine(line: string): ParsedEntry | undefined;
  observedCwd(): string | undefined;
}

export function createCopilotLineParser(absPath: string, cwdHint?: string): CopilotLineParser {
  const sessionId = sessionIdFromPath(absPath); // PARENT-DIR-derived id
  // De-dup is per-ingest-run by event `id` (this parser instance only). A
  // cursor-resume boundary or a compaction re-sync can re-emit an already-stored
  // turn as a duplicate observation — the accepted at-least-once tolerance, same
  // class as Codex/Gemini. Cross-run dedup is a follow-up (out of #69 scope).
  const seen = new Set<string>();
  let cwd = cwdHint;
  let headerCwd: string | undefined;

  return {
    observedCwd: () => headerCwd,
    pushLine: (raw: string): ParsedEntry | undefined => {
      const line = raw.trim();
      if (line.length === 0) return undefined;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        return undefined;
      }
      if (!isRecord(obj)) return undefined;
      const type = asString(obj.type);
      const data = isRecord(obj.data) ? obj.data : undefined;

      if (type === 'session.context_changed' && data) {
        const c = asString(data.cwd);
        if (c) {
          headerCwd = c;
          cwd = c;
        }
        return undefined; // not a turn
      }
      if (!sessionId) return undefined; // cannot group without an id

      if (type !== 'user.message' && type !== 'assistant.message') return undefined;
      const role = type === 'user.message' ? 'user' : 'assistant';

      // Per-event id dedup (NOT used for grouping — the path UUID is canonical).
      const id = asString(obj.id);
      if (id) {
        if (seen.has(id)) return undefined;
        seen.add(id);
      }

      const text = data ? clean(asString(data.content) ?? '') : '';
      const toolAnchors =
        role === 'assistant' && data ? extractCopilotAnchors(data.toolRequests) : [];
      if (text.length === 0 && toolAnchors.length === 0) return undefined; // nothing to keep

      return {
        sessionId,
        role,
        text,
        toolAnchors,
        ...(cwd ? { cwd } : {}),
        ...(asString(obj.timestamp) ? { timestamp: asString(obj.timestamp) } : {}),
        ...(id ? { id } : {}),
      };
    },
  };
}
