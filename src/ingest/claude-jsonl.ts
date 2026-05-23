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
 * We extract human-readable prose (string content + `text` blocks) and, for the
 * verifiable-memory layer (E, issue #25), the code-location signal carried by
 * `Edit`/`Write` `tool_use` blocks — their `file_path` plus any symbols their
 * payload defines. This is the "anchor from the tool-call, not the prose" bet
 * the spike (#22) validated (~97% file-anchorable). We still skip `thinking`
 * and `tool_result` (machine chatter; `thinking` can be large — 8 GB footprint
 * discipline, ADR 0001), and we keep only the compact signal from tool calls,
 * never the full diff.
 */

/** Source-file extensions whose Edit/Write we try to anchor. */
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

/** Definition-introducing patterns we treat as a named symbol the edit touched. */
const SYMBOL_DEF =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:def|function|class|const|func|type|interface)\s+([A-Za-z_]\w+)/g;

function hasCodeExtension(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 && CODE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

/**
 * Collapse an ephemeral worktree path to its canonical main-repo path (FR-C2,
 * #32). Edits made inside `<repo>/.worktrees/<branch>/<rel>` or
 * `<repo>/.claude/worktrees/<id>/<rel>` are about `<repo>/<rel>` — the worktree
 * dir vanishes on merge/cleanup, so anchoring to it is exactly the pollution the
 * killer-test found (~1065 dead worktree paths). Normalizing here keeps the
 * anchor pointing at the file that survives. Non-worktree paths pass through.
 */
export function normalizeWorktreePath(filePath: string): string {
  for (const marker of ['/.worktrees/', '/.claude/worktrees/']) {
    const at = filePath.indexOf(marker);
    if (at < 0) continue;
    const repoRoot = filePath.slice(0, at);
    const tail = filePath.slice(at + marker.length);
    const slash = tail.indexOf('/'); // drop the <branch|id> segment
    if (slash < 0) continue;
    return `${repoRoot}/${tail.slice(slash + 1)}`;
  }
  return filePath;
}

/** A code-location seed extracted from one Edit/Write tool call. */
export interface ToolAnchorSeed {
  /** The tool that produced it (`Edit` or `Write`). */
  tool: string;
  filePath: string;
  /** Symbols the payload appears to define (best-effort; may be empty). */
  symbols: string[];
}

/** A conversation entry we successfully extracted text and/or anchors from. */
export interface ParsedEntry {
  sessionId: string;
  /** `user` or `assistant` — becomes the observation `kind`. */
  role: string;
  /** The human-readable text joined from string/`text` blocks (may be ''). */
  text: string;
  /** Code-location anchors from Edit/Write tool calls in this turn (may be empty). */
  toolAnchors: ToolAnchorSeed[];
  cwd?: string;
  timestamp?: string;
  uuid?: string;
  /** Gemini message id (`randomUUID`); the id-watermark anchor (W-NEW-1, #68). Unset for Claude/Codex. */
  id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Harness-injected wrappers that ride along inside a user turn but are NOT the
 * human's prose (#36): the system-reminder Claude Code appends, and the
 * slash-command / local-command echo. We strip these whole blocks so recall and
 * consolidation see what the user actually wrote, not the injected payload.
 *
 * Skill injection ("Base directory for this skill: …<body>…") is deliberately
 * NOT handled here: there is no machine-readable boundary between the injected
 * skill body and the user's appended args, so it needs its own design (#38).
 */
const INJECTED_WRAPPER =
  /<(system-reminder|command-name|command-message|command-args|command-contents|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g;

/** Remove injected wrappers and collapse the whitespace they leave behind. */
function stripInjectedWrappers(text: string): string {
  return text
    .replace(INJECTED_WRAPPER, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Pull the readable text out of a `message.content`, which is either a string
 * or an array of content blocks. Returns the trimmed join, or '' when there is
 * nothing extractable (tool-only / thinking-only / empty / injected-only).
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return stripInjectedWrappers(content);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'text') continue; // skip thinking / tool_use / tool_result
    const text = asString(block.text);
    if (text === undefined) continue;
    const cleaned = stripInjectedWrappers(text);
    if (cleaned.length > 0) parts.push(cleaned);
  }
  return parts.join('\n\n').trim();
}

/** Extract the symbol names a code payload appears to define (best-effort). */
function extractSymbols(payload: string): string[] {
  const out = new Set<string>();
  for (const m of payload.matchAll(SYMBOL_DEF)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

/**
 * Pull code-location seeds from `Edit`/`Write` tool calls in a content array.
 * Only code-extension files are anchored; `Read` is ignored (not a fact/change).
 * The payload (`new_string` for Edit, `content` for Write) is mined for symbol
 * names — never stored, only its extracted symbols travel onward.
 */
export function extractToolAnchors(content: unknown): ToolAnchorSeed[] {
  if (!Array.isArray(content)) return [];
  const seeds: ToolAnchorSeed[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;
    const tool = asString(block.name);
    if (tool !== 'Edit' && tool !== 'Write') continue;
    const input = isRecord(block.input) ? block.input : undefined;
    const rawPath = input ? asString(input.file_path) : undefined;
    if (!rawPath || !hasCodeExtension(rawPath)) continue;
    // Anchor to the canonical file, not the ephemeral worktree copy (FR-C2).
    const filePath = normalizeWorktreePath(rawPath);
    const payload = input ? (asString(input.new_string) ?? asString(input.content) ?? '') : '';
    seeds.push({ tool, filePath, symbols: extractSymbols(payload) });
  }
  return seeds;
}

/**
 * Parse one JSONL line into a `ParsedEntry`, or `null` when the line should be
 * skipped: blank, malformed JSON, a non-conversation entry, or an entry with
 * neither extractable text nor an Edit/Write anchor. Never throws — a bad line
 * is a skip, not a crash.
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

  // Harness-injected turns (skill bodies, hook notifications, other system
  // context) carry top-level `isMeta: true` (#38). They are not the human's
  // conversation — storing them inflates the store and pollutes recall — and the
  // user's real intent survives in the non-meta turns, so drop them outright.
  if (obj.isMeta === true) return null;

  const sessionId = asString(obj.sessionId);
  if (!sessionId) return null; // can't group it — skip

  const message = obj.message;
  if (!isRecord(message)) return null;
  const role = asString(message.role) ?? type;

  const text = extractText(message.content);
  const toolAnchors = extractToolAnchors(message.content);
  // Skip only when there is nothing to keep: no prose AND no anchorable edit.
  // A thinking-only or unrelated tool-only turn (e.g. Bash) lands here.
  if (text.length === 0 && toolAnchors.length === 0) return null;

  return {
    sessionId,
    role,
    text,
    toolAnchors,
    cwd: asString(obj.cwd),
    timestamp: asString(obj.timestamp),
    uuid: asString(obj.uuid),
  };
}
