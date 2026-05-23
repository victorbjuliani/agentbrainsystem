/**
 * Codex CLI rollout-transcript parsing (#67).
 *
 * Codex writes `~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<UUID>.jsonl`. Unlike
 * Claude Code, the session id is NOT on every line — it lives in the leading
 * `session_meta` line (and the filename UUID). Conversation prose is carried by
 * `response_item` lines with `payload.type === "message"` and content blocks of
 * type `input_text` (user) / `output_text` (assistant). The `event_msg`
 * `user_message`/`agent_message` lines normally mirror the same text and are
 * de-duped by normalized text (captured once); a turn that exists ONLY as an
 * `event_msg` (no `response_item` twin) is still captured rather than dropped
 * (W-NEW-4). Tool calls are separate `function_call` lines (anchoring from them
 * is a follow-on; this parser emits prose only).
 *
 * The sessionId is derived from the FILENAME UUID (`sessionIdFromPath`) so it is
 * known on every read, header or not (W4 — enables cursor streaming). A header,
 * when present, refines `cwd`; otherwise `cwdHint` (from the ingest kv_meta cache)
 * provides it.
 */
import type { ParsedEntry } from './claude-jsonl.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Extract the session UUID from a `rollout-<ts>-<UUID>.jsonl` filename (N5).
 * Anchored on the ISO timestamp shape so the greedy timestamp segment cannot
 * eat into the UUID.
 */
function sessionIdFromPath(path: string): string | undefined {
  const m = path.match(
    /rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return m?.[1];
}

const INJECTED_WRAPPER =
  /<(system-reminder|command-name|command-message|command-args|command-contents|local-command-stdout|local-command-caveat|INSTRUCTIONS)>[\s\S]*?<\/\1>/g;
// Codex prepends the project AGENTS.md to the FIRST user turn as
// `# AGENTS.md instructions for <path>\n\n<INSTRUCTIONS>…</INSTRUCTIONS>`. The
// `<INSTRUCTIONS>` block is stripped by INJECTED_WRAPPER above; this strips the
// one-line `# AGENTS.md instructions for …` preamble that introduces it. Anchored
// on `^# AGENTS.md instructions` so it only matches the injected header, never
// legitimate user prose that merely mentions agents or instructions.
const AGENTS_PREAMBLE = /^#\s*AGENTS\.md instructions for .*$/gim;
function clean(text: string): string {
  return text
    .replace(INJECTED_WRAPPER, '')
    .replace(AGENTS_PREAMBLE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Join `input_text`/`output_text` blocks of a response_item message into prose. */
function extractContent(content: unknown): string {
  if (typeof content === 'string') return clean(content);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'input_text' && block.type !== 'output_text') continue;
    const text = asString(block.text);
    if (text === undefined) continue;
    const c = clean(text);
    if (c.length > 0) parts.push(c);
  }
  return parts.join('\n\n').trim();
}

/** Result of parsing a Codex rollout slice: the entries + any cwd seen in session_meta. */
export interface CodexParseResult {
  entries: ParsedEntry[];
  /** The cwd from `session_meta` if this slice included the header, else undefined. */
  cwd: string | undefined;
}

/**
 * A stateful per-line Codex parser (Task 5 seam). Holds the rolling cwd/header
 * state + the de-dup `seen` set; `pushLine(line)` returns a `ParsedEntry` for a
 * captured turn or `undefined` for a skipped/duplicate line. `observedCwd()`
 * returns the cwd seen in a `session_meta` header during this parse (for the
 * kv_meta cache). The whole-slice `codexParseTranscript` is a thin wrapper over
 * this, so the per-line and whole-slice paths share identical line handling.
 */
export interface CodexLineParser {
  pushLine(line: string): ParsedEntry | undefined;
  observedCwd(): string | undefined;
}

export function createCodexLineParser(absPath: string, cwdHint?: string): CodexLineParser {
  const sessionId = sessionIdFromPath(absPath); // FILENAME-derived id (W4)
  // De-dup is per-ingest-run (this parser instance only). A cursor-resume boundary
  // that falls BETWEEN a response_item and its event_msg twin can yield one duplicate
  // observation — accepted at-least-once tolerance, the same class as the Claude path.
  // A persistent (cross-run) dedup is a follow-up (W2, #67).
  const seen = new Set<string>(); // normalized "role text" already captured — de-dup event_msg twins
  let cwd = cwdHint;
  let headerCwd: string | undefined;

  /** Build an entry unless its normalized text was already captured (de-dup twins). */
  const make = (
    role: 'user' | 'assistant',
    text: string,
    timestamp: string | undefined,
  ): ParsedEntry | undefined => {
    const key = `${role} ${text.replace(/\s+/g, ' ').trim().toLowerCase()}`;
    if (seen.has(key)) return undefined; // a response_item already captured this turn
    seen.add(key);
    return {
      sessionId: sessionId as string,
      role,
      text,
      toolAnchors: [],
      ...(cwd ? { cwd } : {}),
      ...(timestamp ? { timestamp } : {}),
    };
  };

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
      const payload = isRecord(obj.payload) ? obj.payload : undefined;

      if (type === 'session_meta' && payload) {
        headerCwd = asString(payload.cwd) ?? headerCwd;
        cwd = headerCwd ?? cwd;
        return undefined; // session_meta.id is NOT used for grouping — the filename UUID is canonical (W4)
      }
      if (!sessionId) return undefined; // cannot group without an id

      // --- Primary source: response_item/message (W-NEW-4) ---
      if (type === 'response_item' && payload && payload.type === 'message') {
        const role = asString(payload.role);
        if (role !== 'user' && role !== 'assistant') return undefined; // skip 'developer' system turns
        const textOut = extractContent(payload.content);
        if (textOut.length === 0) return undefined; // tool-only / empty
        return make(role, textOut, asString(obj.timestamp));
      }

      // --- Fallback source: event_msg with NO response_item/message twin (W-NEW-4) ---
      if (type === 'event_msg' && payload) {
        const evt = asString(payload.type);
        const role =
          evt === 'user_message' ? 'user' : evt === 'agent_message' ? 'assistant' : undefined;
        if (!role) return undefined; // skip token_count/task_*/patch_apply_end/etc.
        const textOut = clean(asString(payload.message) ?? '');
        if (textOut.length === 0) return undefined;
        return make(role, textOut, asString(obj.timestamp)); // de-dup guard inside make() drops twins
      }
      // everything else (turn_context, function_call, reasoning, …) is skipped
      return undefined;
    },
  };
}

/**
 * Parse a Codex rollout transcript (whole file OR a cursor-resumed slice) into
 * entries. The sessionId is the FILENAME UUID (always present, even mid-file —
 * W4). The `cwd` comes from `session_meta` when the slice includes it, else from
 * `cwdHint`. Never throws — malformed lines are skipped.
 */
export function codexParseTranscript(
  text: string,
  absPath: string,
  cwdHint?: string,
): CodexParseResult {
  const parser = createCodexLineParser(absPath, cwdHint);
  const entries: ParsedEntry[] = [];
  for (const raw of text.split('\n')) {
    const entry = parser.pushLine(raw);
    if (entry) entries.push(entry);
  }
  return { entries, cwd: parser.observedCwd() };
}
