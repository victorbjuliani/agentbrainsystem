/**
 * Gemini CLI chat-transcript parsing (#68).
 *
 * Gemini writes ONE JSON file per session (NOT JSONL):
 * `~/.gemini/tmp/<slug>/chats/session-<ts>-<8hex>.json`, a `ConversationRecord`
 * that the recorder REWRITES WHOLE on every message (append-only EXCEPT `/rewind`,
 * which truncates the array). So this parser reads the entire document at once;
 * the ingest branch (NOT this parser) handles re-ingest gating via an id-anchored
 * watermark — there is no byte cursor.
 *
 * Each message carries a stable `id` (`randomUUID()`), which we emit on every
 * `ParsedEntry` as the watermark anchor (W-NEW-1). The chat JSON has NO cwd
 * (only `sessionId`/`projectHash`/`messages`; `projectHash` is sha256(cwd),
 * irreversible), so this parser emits NO `cwd` (C-NEW-1) — the ingest branch
 * recovers the real cwd from the sibling `.project_root` marker.
 *
 * Role mapping: `type:"user"` → user prose; `type:"gemini"` → assistant prose;
 * `type:"info"|"error"|"warning"` → skip (UI chrome). `content` is `PartListUnion`
 * = string OR `Part[]`; we flatten only the `{text}` parts (prose-only MVP, like
 * the Codex parser — tool anchors are a follow-on).
 */
import type { ParsedEntry } from './claude-jsonl.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// Same harness-injected wrappers the Claude/Codex parsers strip (#36): not the
// human's prose. Mirrored here to keep gemini-chat a self-contained leaf.
const INJECTED_WRAPPER =
  /<(system-reminder|command-name|command-message|command-args|command-contents|local-command-stdout|local-command-caveat|INSTRUCTIONS)>[\s\S]*?<\/\1>/g;
function clean(text: string): string {
  return text
    .replace(INJECTED_WRAPPER, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Flatten a `PartListUnion` (string OR Part[]) to prose — `{text}` parts only. */
function extractParts(content: unknown): string {
  if (typeof content === 'string') return clean(content);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const text = asString(part.text);
    if (text === undefined) continue; // ignore {functionCall}/{functionResponse}
    const c = clean(text);
    if (c.length > 0) parts.push(c);
  }
  return parts.join('\n\n').trim();
}

/**
 * Parse a whole Gemini chat JSON document into ordered prose entries, each tagged
 * with its message `id` (the watermark anchor, W-NEW-1). Never throws — malformed
 * JSON / wrong shape → `[]`. The session id is the in-file `sessionId` (the full
 * UUID); we do NOT guess a truncated id from the filename — when it is absent we
 * return `[]` rather than mis-namespace against the payload's full UUID.
 */
export function parseGeminiChat(raw: string, _absPath: string): ParsedEntry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return []; // malformed → skip the whole file
  }
  if (!isRecord(doc) || !Array.isArray(doc.messages)) return [];
  const sessionId = asString(doc.sessionId);
  if (!sessionId) return []; // no full UUID → cannot namespace; skip rather than guess
  const out: ParsedEntry[] = [];
  for (const m of doc.messages as unknown[]) {
    if (!isRecord(m)) continue;
    const type = asString(m.type);
    if (type !== 'user' && type !== 'gemini') continue; // skip info/error/warning chrome
    const id = asString(m.id);
    if (!id) continue; // no id → cannot watermark; skip (every real message has one)
    const role = type === 'gemini' ? 'assistant' : 'user';
    const text = extractParts(m.content);
    if (!text) continue; // prose-only MVP (anchors are a follow-on)
    out.push({ sessionId, role, text, toolAnchors: [], id });
  }
  return out;
}
