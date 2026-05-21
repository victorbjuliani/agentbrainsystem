/**
 * Claude Code hook payload parsing + the context-injection wire format (#15/#16/#19).
 *
 * Claude Code spawns each hook as a command and pipes a JSON object on stdin with
 * fields like `session_id`, `transcript_path`, `cwd`, `hook_event_name` (and, for
 * UserPromptSubmit, `prompt`; for SessionStart, `source`). We parse defensively:
 * the payload is treated as untrusted input on the critical path, so a malformed
 * or partial blob must degrade to "no usable fields" rather than throw — the
 * non-fatal contract (ADR-0004) means a hook never blocks the session.
 *
 * Context injection (SessionStart / UserPromptSubmit only) uses the explicit JSON
 * form Claude Code documents:
 *   {"hookSpecificOutput":{"hookEventName":"<Event>","additionalContext":"<text>"}}
 * SessionEnd cannot inject — it just runs.
 */

/** The hook events this project registers. Keep in sync with the installer registry. */
export type HookEvent = 'SessionEnd' | 'SessionStart' | 'UserPromptSubmit';

/** Parsed, validated subset of a Claude Code hook stdin payload. All optional — untrusted. */
export interface HookPayload {
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  hookEventName?: string;
  /** UserPromptSubmit only. */
  prompt?: string;
  /** SessionStart only (e.g. 'startup' | 'resume' | 'clear'). */
  source?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Parse the raw stdin blob into a `HookPayload`. Never throws: any parse error or
 * non-object payload yields an empty payload, so callers always get a safe shape.
 */
export function parseHookPayload(raw: string): HookPayload {
  let obj: Record<string, unknown>;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return {};
    obj = v as Record<string, unknown>;
  } catch {
    return {};
  }
  const payload: HookPayload = {};
  const sessionId = str(obj.session_id);
  if (sessionId) payload.sessionId = sessionId;
  const transcriptPath = str(obj.transcript_path);
  if (transcriptPath) payload.transcriptPath = transcriptPath;
  const cwd = str(obj.cwd);
  if (cwd) payload.cwd = cwd;
  const hookEventName = str(obj.hook_event_name);
  if (hookEventName) payload.hookEventName = hookEventName;
  const prompt = str(obj.prompt);
  if (prompt) payload.prompt = prompt;
  const source = str(obj.source);
  if (source) payload.source = source;
  return payload;
}

/**
 * Build the JSON line Claude Code reads from stdout to inject `text` as additional
 * context for `event`. Returns null for an empty/whitespace-only block so callers
 * emit nothing rather than an empty injection.
 */
export function buildContextOutput(event: HookEvent, text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: trimmed },
  });
}

/** Read all of stdin as a UTF-8 string. Resolves '' on a closed/empty stdin. */
export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
