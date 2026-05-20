/**
 * Claude Code transcript parsing (issue #7).
 *
 * A Claude Code transcript is JSONL: one JSON object per line under
 * `~/.claude/projects/<encoded-project>/<sessionId>.jsonl`. Conversation entries
 * carry `type` (`user` / `assistant`), a `message` ({ role, content }), plus
 * `sessionId`, `cwd`, `timestamp`, `uuid`. `content` is either a plain string
 * (typical user turn) or an array of content blocks (assistant turns:
 * `text` / `thinking` / `tool_use`; user turns may carry `tool_result`).
 *
 * We extract only human-readable prose: string content, and `text` blocks. We
 * deliberately skip `thinking`, `tool_use`, and `tool_result` blocks — they are
 * machine chatter, not memory-worthy, and `thinking` blocks can be large (8 GB
 * footprint discipline, ADR 0001).
 */

/** A conversation entry we successfully extracted text from. */
export interface ParsedEntry {
  sessionId: string;
  /** `user` or `assistant` — becomes the observation `kind`. */
  role: string;
  /** The human-readable text joined from string/`text` blocks. */
  text: string;
  cwd?: string;
  timestamp?: string;
  uuid?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Pull the readable text out of a `message.content`, which is either a string
 * or an array of content blocks. Returns the trimmed join, or '' when there is
 * nothing extractable (tool-only / thinking-only / empty).
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'text') continue; // skip thinking / tool_use / tool_result
    const text = asString(block.text);
    if (text && text.trim().length > 0) parts.push(text.trim());
  }
  return parts.join('\n\n').trim();
}

/**
 * Parse one JSONL line into a `ParsedEntry`, or `null` when the line should be
 * skipped: blank, malformed JSON, a non-conversation entry, or an entry with no
 * extractable text. Never throws — a bad line is a skip, not a crash.
 */
export function parseLine(line: string): ParsedEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null; // malformed JSON
  }
  if (!isRecord(obj)) return null;

  const type = asString(obj.type);
  if (type !== 'user' && type !== 'assistant') return null; // not a conversation turn

  const sessionId = asString(obj.sessionId);
  if (!sessionId) return null; // can't group it — skip

  const message = obj.message;
  if (!isRecord(message)) return null;
  const role = asString(message.role) ?? type;

  const text = extractText(message.content);
  if (text.length === 0) return null; // tool-only / thinking-only / empty

  return {
    sessionId,
    role,
    text,
    cwd: asString(obj.cwd),
    timestamp: asString(obj.timestamp),
    uuid: asString(obj.uuid),
  };
}
