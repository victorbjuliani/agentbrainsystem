# Plan — GitHub Copilot CLI harness adapter (#69)

- **Issue:** #69 — fourth qualifying harness behind the Phase-0 contract.
- **Branch / worktree:** `feat/harness-copilot` @ `.worktrees/h69` (stacked on merged Phase0 + Codex #67 + Gemini #68).
- **Stack:** npm + Node ≥22 + TypeScript (ESM), Biome, Vitest. Validation: `npm run check` (lint → typecheck → test). Run `npm run build` before exercising the real `abs` CLI.
- **TDD:** every task is RED (failing test) → GREEN (minimal impl) → REFACTOR. Sibling `*.test.ts` per module, Vitest, the established convention in `src/harness/**` and `src/ingest/**`.
- **Method:** bite-sized, each task independently committable, no placeholders.

---

## Ground truth (Copilot, verified on disk)

Probed against the real install: **GitHub Copilot CLI 1.0.51** at `/opt/homebrew/bin/copilot`, global SDK package `/opt/homebrew/lib/node_modules/@github/copilot` (`app.js` 12.4 MB minified; `schemas/session-events.schema.json` 359 KB; `schemas/api.schema.json`). All findings below are from the binary, its bundled JSON schemas, and a real on-disk plugin `hooks.json` — except where explicitly flagged "unverified (needs auth)".

### Install detection
- Config dir: `~/.copilot/`. On a fresh box it contains only `installed-plugins/`. Merely launching `copilot` (even when auth fails) creates `~/.copilot/config.json`, `logs/`, `session-store.db`, and `session-state/<uuid>/`. **Detect by `access(~/.copilot)`** — exactly the Codex/Gemini pattern.

### MCP — `copilot mcp add` exists (CLI, separator style)
- Real subcommand: `copilot mcp add <name> [url-or-command-and-args...]`. For a **local stdio** server the command goes after `--`:
  `copilot mcp add agentbrainsystem -- node <cliPath> start` (default transport is `stdio`).
- `copilot mcp list` / `copilot mcp get <name>` / `copilot mcp remove <name>` all exist.
- Config is loaded from `~/.copilot/mcp-config.json` (user) and `.mcp.json` (workspace). The `add` CLI writes the user file; **we do NOT need a file-writing variant** — the binary owns the write.
- **The `--` separator is ACCEPTED** (unlike Gemini, which rejects it). So Copilot uses the *default* `argStyle: 'separator'` — a pure binary swap of the existing `cliMcpRegistrar`. No `--scope` needed (Copilot has no per-scope add flag; user config is the default target).
- Help confirms: `copilot mcp add context7 -- npx -y @upstash/context7-mcp` — identical shape to the Claude/Codex registrar output `<binary> mcp add agentbrainsystem -- node <cli> start`.

### Hooks — Claude-STYLE, JSON config, snake_case stdin payload
- **Event set** (from `app.js`): `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `preCompact`, `notification`, `stop`. This is essentially Claude Code's hook model.
- **Config shape — verified against a REAL installed plugin** at
  `~/.copilot/installed-plugins/_direct/copilot-plugin/hooks.json` (a third-party "Masko" plugin):

  ```json
  {
    "hooks": {
      "sessionStart":    [ { "type": "command", "bash": "~/.masko-desktop/hooks/copilot-hook.sh SessionStart" } ],
      "sessionEnd":      [ { "type": "command", "bash": "~/.masko-desktop/hooks/copilot-hook.sh SessionEnd" } ],
      "userPromptSubmit":[ { "type": "command", "bash": "~/.masko-desktop/hooks/copilot-hook.sh UserPromptSubmit" } ],
      "preToolUse":      [ { "type": "command", "bash": "~/.masko-desktop/hooks/copilot-hook.sh PreToolUse" } ],
      "postToolUse":     [ { "type": "command", "bash": "~/.masko-desktop/hooks/copilot-hook.sh PostToolUse" } ],
      "errorOccurred":   [ { "type": "command", "bash": "~/.masko-desktop/hooks/copilot-hook.sh ErrorOccurred" } ]
    },
    "version": 1
  }
  ```

  Two facts the plain `app.js` grep would have gotten wrong:
  1. **The entry key is `bash`, NOT `command`.** A hook entry is `{ "type": "command", "bash": "<shell string>" }`. (The zod runtime also accepts `powershell` and a normalized `command`/`args`, but the canonical on-disk form a plugin ships is `bash`.) The shell string is a single command line — args are part of the string, not a separate `args` array.
  2. **The map is FLAT: `event -> [ entry, ... ]`** — NOT Claude's nested `event -> [{ matcher, hooks: [...] }]`. There is no `matcher` wrapper in the plugin format. (`preToolUse`/`postToolUse` can take a matcher in the zod schema, but the plugin ships flat arrays; we will write flat arrays and not depend on matcher support.)
  3. **`version: 1`** at the top level.

  > ⚠️ **Event-name discrepancy to resolve in Task 2/3 (flagged, not yet verified live).** The plugin file uses **`userPromptSubmit`** (no "-ted"), while `app.js` internals use **`userPromptSubmitted`**. The internal canonical key is almost certainly `userPromptSubmitted` and the plugin loader tolerates/aliases the short form, but this is **unverified without an authed session that actually fires the hook**. Task 3 writes `userPromptSubmitted` (matching the internal grep) and the live-acceptance task (Task 8) must confirm which key the recall hook actually fires under. If the authed run shows the prompt hook never fires, switch the installer key to `userPromptSubmit`.

- **Config file locations** (from `app.js`):
  - User/personal hooks: a `hooks.json` (the plugin precedent) and a `settings.json` under `~/.copilot/`. The literal `"settings.json they act as repo-level hooks"` and `getHooksDir → <gitRoot>/.github/hooks` show repo-level hooks live at `.github/hooks/` and repo settings at `.github/copilot/settings.json` / `.github/copilot/settings.local.json`.
  - **Decision (Task 3):** write our managed hooks to a **user-level `~/.copilot/hooks.json`** (the same file shape the Masko plugin ships, top-level `{hooks, version:1}`). This is the personal, project-agnostic install that mirrors how the Claude/Gemini installers target `~/.claude/settings.json` / `~/.gemini/settings.json`. Repo-scoped `.github/hooks` install is **out of scope** for #69 (note as a follow-up).

- **Hook stdin payload — Claude-style snake_case** (from `app.js`, base builder `M6`):
  ```
  { hook_event_name, session_id, timestamp(ISO 8601), cwd,
    session_name, transcript_path, model:{id,display_name},
    workspace:{current_dir}, username, ... }
  ```
  i.e. the payload carries **`session_id`, `cwd`, AND `transcript_path`** on stdin — the same three fields the existing `abs hook` handler already reads. `transcript_path` points at the session's **`events.jsonl`** (the SDK exposes `getEventFilePath` → "Absolute path to the session's events.jsonl file on disk"). **This is the linchpin: the chokepoint's `harnessForPayload(payload.transcriptPath)` will see a Copilot events.jsonl path and must namespace it `copilot:`.**

### Transcript — `events.jsonl`, append-mostly JSONL
- Path layout: **`~/.copilot/session-state/<sessionId>/events.jsonl`**. Verified the `session-state/<uuid>/` dir is created on launch (uuid `3db5c133-…` appeared); the `events.jsonl` itself only materializes once a session produces turns (our launch failed auth before any turn, so the file was absent — see "unverified" below).
- `events.jsonl` is **JSON-Lines**, one event object per line. Write path uses `appendFile` (12 occurrences) — **append-per-event**. The only rewrite path is a `truncate` operation (`g.slice(0, idx)` from an event id) used by **compaction/fork** (`session.compaction_complete`, `loadForkSourceWorkspace`, `rewriteForkedSessionPaths`). So: **append-mostly, with a rare compaction/fork rewrite.**
- **Per-event envelope** (from `session-events.schema.json`): every event is
  `{ id: string, timestamp: string(date-time, ISO 8601), parentId, ephemeral, agentId, type: string, data: object }`.
- **Conversation events** (the ones we ingest):
  - `user.message` → `data.content: string` (also `transformedContent`, `source`, `interactionId`, `attachments`).
  - `assistant.message` → `data.content: string` (also `model`, `messageId`, `outputTokens`, `toolRequests: array`, `turnId`).
- **cwd is NOT on the message events.** The only event whose `data` carries `cwd` is **`session.context_changed`**. This mirrors Codex exactly (cwd lives in a header-ish event, not per message) → recover cwd from that event and cache it in kv_meta for header-less tail resumes.
- **Tool anchors:** `assistant.message.data.toolRequests` is an array of tool calls (analogue of Claude's `tool_use` blocks). Edit/Write anchoring (FR-C2) reads file paths from there — best-effort, mirroring `extractToolAnchors`. Exact `toolRequests` element schema (the `Write`/`str_replace` arg key names) is **partially verified** (schema confirms the array exists; the per-tool arg keys need a real transcript — see "unverified"). Task 4 implements prose-text extraction first (fully verified) and treats tool-anchor mining as a best-effort secondary that degrades to "no anchors" when the shape doesn't match.

### Session id source
- **Filename/dir UUID** is canonical: `session-state/<uuid>/events.jsonl` → the `<uuid>` is the session id (matches the hook payload `session_id`). The events themselves carry per-event `id`/`parentId` but NOT a session id field, so — exactly like Codex — **derive the session id from the path**, not from the line. Confirmed `session_id` on the hook stdin equals this dir uuid.
- **No session-id env var** analogous to `CLAUDE_CODE_SESSION_ID` was found (the resolution is payload/path-driven). → use the **payload-only** `payloadFirstResolver()` (same as Codex/Gemini).

### Instruction file
- Copilot uses `copilot init` to write repo instructions; the literals show `.copilot/copilot-instructions` and `.github/copilot-instructions.md` style. Project context injection for ABS is **out of scope** for #69 (the context-injector is a separate capability already shared; #69 only needs detect/install/MCP/transcript). Note as non-goal.

### Explicitly UNVERIFIED (needs an authed `copilot` run)
`copilot` requires GitHub auth (`/login`, or `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`, or `gh auth login`) to produce conversation turns. We could launch the binary (it created `session-state/<uuid>/`) but it errored `No authentication information found` before writing any `events.jsonl`. Therefore, **deferred to a live/authed acceptance run (Task 8), exactly like Gemini's API-key deferral:**
1. A real `events.jsonl` sample with actual `user.message` + `assistant.message` lines (we reverse-engineered the per-line schema from `schemas/session-events.schema.json`, which is the SDK's own source of truth, but never saw a populated file).
2. The exact `assistant.message.data.toolRequests[]` element shape (Edit/Write arg key names) for anchor mining.
3. Whether the recall hook fires under config key `userPromptSubmitted` or `userPromptSubmit`.
4. Confirmation the hook stdin `transcript_path` literally equals `~/.copilot/session-state/<uuid>/events.jsonl` at fire time (vs. created lazily after the first turn — the early-empty-path gap Gemini documented).

All fixture-based tests below are written against the **reverse-engineered real schema** (`session-events.schema.json` + the live plugin `hooks.json`), so they are faithful to the install, not to research guesses.

---

## CRITICAL decision — cursor / dedup model

**Copilot `events.jsonl` is append-mostly line-delimited JSONL → use a BYTE-OFFSET cursor (the Codex model), NOT Gemini's id-watermark.**

Rationale:
- The normal turn-by-turn write is `appendFile` of one JSON object per line → a byte cursor resumes cleanly from EOF, identical to Codex rollouts. This is what made Codex #67 a byte cursor and why Gemini #68 needed a watermark (Gemini rewrites the *whole* file every message).
- The one rewrite path is **compaction/fork** (`truncate` = `slice(0, idx)`), which removes *already-ingested old* events and keeps the tail. After a compaction the file is shorter than the cursor → guard with the standard `cursor >= size` check already in `ingestSingleSession` (line 438–439): when `size < cursor` we must **reset the cursor to the new size's start of unread tail**. The existing Codex path already tolerates "cursor past EOF ⇒ skip"; the compaction case where the *file shrank but new content was appended after* is the one edge to handle.
  - **Decision:** treat it like Codex (byte cursor) and add ONE guard: if persisted `cursor > currentSize`, the file was rewritten (compaction/fork) → **reset cursor to 0 and re-ingest from the top**, relying on the per-observation dedup (`seen` set keyed by event `id` within the parse, plus the store's idempotent write) to avoid duplicates. This is at-least-once (a compaction may re-emit a few already-stored turns) — the SAME risk class Codex/Gemini already accept, never a silent drop. This is the bug class that bit #67/#68; we choose the conservative re-sync over a silent gap.
- **Grouping id = filename dir UUID** (path-derived), cached-cwd from `session.context_changed` via kv_meta — byte-for-byte the Codex parser strategy.

---

## Tasks (bite-sized TDD)

### Task 1 — Extend namespacing leaf: `isCopilotTranscript` + `harnessForPayload`
**File:** `src/ingest/namespacing.ts` (+ `src/ingest/namespacing.test.ts` if present, else colocated harness test).

RED: add tests that
- `isCopilotTranscript('/Users/x/.copilot/session-state/3db5c133-d9b9-419c-a649-d8d1b0514c49/events.jsonl')` → `true`
- a Claude/Codex/Gemini path → `false`
- `harnessForPayload({ transcriptPath: '<copilot events.jsonl path>' })` → `'copilot'`
- empty/absent path → `'claude-code'` (unchanged safe default)

GREEN:
```ts
/** True when the path is a Copilot CLI session transcript (drives parser + namespace, #69). */
export function isCopilotTranscript(absPath: string): boolean {
  return (
    absPath.includes('/.copilot/session-state/') &&
    /\/session-state\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/events\.jsonl$/i.test(
      absPath,
    )
  );
}
```
and extend `harnessForPayload` (order does not matter — path shapes are disjoint):
```ts
  if (isCopilotTranscript(p)) return 'copilot';
```
REFACTOR: keep the doc-comment style consistent with the Codex/Gemini siblings.

> Chokepoint + `namespacedExternalId` need NO change: `namespacedExternalId('copilot', uuid)` already yields `copilot:<uuid>` (everything non-`claude-code` is prefixed). Namespacing/chokepoint were solved by #67.

### Task 2 — Copilot event-map (real event names)
This is data carried by the adapter (Task 6) and consumed by the installer (Task 3). No standalone module; define the canonical mapping in the installer's `COPILOT_HOOKS` table and the adapter's `eventMap`. Verified Copilot event names → canonical moments:

| Copilot event | `abs hook` arg | moment |
|---|---|---|
| `sessionEnd` | `session-end` | capture |
| `sessionStart` | `session-start` | recall |
| `userPromptSubmitted` | `user-prompt-submit` | recall |
| `preToolUse` | `pre-tool-use` | guard |

> Copilot **HAS `sessionEnd`** (like Gemini, unlike Codex's `Stop`). Capture is `sessionEnd`. (See the `userPromptSubmitted` vs `userPromptSubmit` ⚠️ above — Task 8 confirms.)

### Task 3 — Copilot hook installer (`copilot-lifecycle-installer.ts`)
**File:** `src/harness/capabilities/copilot-lifecycle-installer.ts` (+ `.test.ts`).
**Template:** `gemini-lifecycle-installer.ts` (the JSON-settings variant), adapted to Copilot's **flat `event -> [{type,bash}]` + `version:1`** shape.

Key differences from the Gemini installer (do NOT blindly copy):
- Target file: `~/.copilot/hooks.json` (option `hooksPath`, default via `join(homedir(), '.copilot', 'hooks.json')`).
- Top-level object is `{ hooks: HookMap, version: 1 }` — **preserve `version` and any other top-level keys** the user has.
- `HookMap` is **flat**: `Record<string, CopilotHookEntry[]>` where `CopilotHookEntry = { type: 'command'; bash: string }`. **No matcher groups.**
- Managed identity = the exact `bash` string `"<baseCommand> <arg>"` (default base `abs hook`), e.g. `"abs hook session-end"`. Add-if-absent / skip-if-present / remove-only-ours, same idempotent + atomic + symlink-refusal + backup-first contract as Gemini (copy the four private safety helpers verbatim — the Codex/Gemini precedent; `installer.ts` stays byte-identical, no shared `settings-io.ts`).

RED tests (against a temp `hooks.json`):
1. install into a **missing** file → creates `{hooks:{sessionStart:[{type:'command',bash:'abs hook session-start'}], ...}, version:1}`.
2. install is **idempotent** (second install = byte-identical, no second backup).
3. install **preserves** a pre-existing unrelated hook entry AND a pre-existing top-level key (e.g. user's own `sessionStart` bash entry survives, our entry is appended to the array).
4. install **preserves `version`** and a foreign top-level field.
5. uninstall removes **only** our `bash` entries, drops emptied event keys, leaves foreign entries + `version` intact.
6. symlinked `hooks.json` → refuses to write (throws).
7. malformed JSON → starts fresh but backs up the original bytes first.

```ts
export interface CopilotHookSpec { event: string; moment: LifecycleMoment; arg: string; }
export const COPILOT_HOOKS: readonly CopilotHookSpec[] = [
  { event: 'sessionEnd', moment: 'capture', arg: 'session-end' },
  { event: 'sessionStart', moment: 'recall', arg: 'session-start' },
  { event: 'userPromptSubmitted', moment: 'recall', arg: 'user-prompt-submit' },
  { event: 'preToolUse', moment: 'guard', arg: 'pre-tool-use' },
];
interface CopilotHookEntry { type: 'command'; bash: string; }
type HookMap = Record<string, CopilotHookEntry[]>;
interface CopilotConfig { hooks?: HookMap; version?: number; [k: string]: unknown; }
```
Install loop: for each spec, `command = "${baseCommand} ${spec.arg}"`; if `hooks[event]` already has an entry whose `bash === command`, skip; else append `{type:'command', bash:command}`. Final object `{ ...config, hooks, version: config.version ?? 1 }`. Serialize `JSON.stringify(next, null, 2) + '\n'`; no-op short-circuit when serialized === before; backup + atomic temp+rename otherwise.

### Task 4 — Copilot transcript parser (`copilot-jsonl.ts`)
**File:** `src/ingest/copilot-jsonl.ts` (+ `.test.ts`).
**Template:** `codex-jsonl.ts` (stateful per-line parser: path-derived sessionId + cwd-from-event cache + dedup `seen` set + `pushLine`/`observedCwd`). **Reuse the shared `ParsedEntry` interface** from `claude-jsonl.ts` (it already has the optional `id`, `cwd`, `timestamp`, `uuid`, `toolAnchors` fields).

Why a dedicated parser, not `parseLine` reuse: Copilot lines are `{type:'user.message'|'assistant.message', id, timestamp, data:{content,...}}` — a different envelope from Claude's `{type:'user'|'assistant', message:{content}}`. The Codex parser is the right shape (it already handles "cwd lives in a non-message event, sessionId from filename").

```ts
export interface CopilotLineParser {
  pushLine(line: string): ParsedEntry | undefined;
  observedCwd(): string | undefined;
}
export function createCopilotLineParser(absPath: string, cwdHint?: string): CopilotLineParser;
```
Behavior:
- `sessionId` = the `<uuid>` dir name from the path (`.../session-state/<uuid>/events.jsonl`), via a `sessionIdFromPath` helper (mirror Codex's filename-UUID extraction, but read the **parent dir** name).
- On a `session.context_changed` line whose `data.cwd` is a string → record it as `headerCwd`/`cwd` (cache target for kv_meta), return `undefined` (not a turn).
- On `user.message` / `assistant.message` → build a `ParsedEntry`:
  - `role` = `'user'` for `user.message`, `'assistant'` for `assistant.message`.
  - `text` = `data.content` (string) run through the SAME `stripInjectedWrappers`/extraction discipline reused from `claude-jsonl.ts` where applicable; Copilot content is a plain string so extraction is `stripInjectedWrappers(data.content)`.
  - `id` = the event `id` (used for the in-parse `seen` dedup set, NOT for grouping).
  - `timestamp` = event `timestamp` (ISO 8601, store as `createdAt`).
  - `cwd` = the cached `cwd`.
  - `toolAnchors` = best-effort from `assistant.message.data.toolRequests[]` (Edit/Write file paths); **degrade to `[]`** when the shape is unrecognized (the exact arg-key schema is the Task-8 unverified item).
  - Empty `data.content` AND no anchors → return `undefined` (skip), matching `parseLine`'s "neither text nor anchor" rule.
- Never throws: malformed/blank/non-conversation line → `undefined`.

RED tests use a **fixture** `src/ingest/__fixtures__/copilot-events.jsonl` hand-built from the real `session-events.schema.json` envelope:
- a `session.info` / `session.context_changed` line with `data.cwd` → parser records cwd, returns undefined.
- a `user.message` line → `{role:'user', text, id, timestamp, cwd}`.
- an `assistant.message` line → `{role:'assistant', text, ...}`.
- a blank line / a `assistant.message_delta` (streaming) line → undefined (we ingest only finalized `*.message`, not `*_delta`).
- a duplicate event `id` → second push returns undefined (dedup).
- `observedCwd()` returns the `session.context_changed` cwd.

### Task 5 — Wire the Copilot branch into `ingestFile`
**File:** `src/ingest/ingest.ts` (+ extend `ingest.test.ts`).

Add a selector branch in `ingestFile`, BEFORE the Codex branch (path shapes are disjoint; order is for readability), mirroring the Codex block 343–372:
```ts
if (isCopilotTranscript(absPath)) {
  const cwdHint = memory.store.getMeta(`${COPILOT_CWD_PREFIX}${absPath}`) ?? undefined;
  const parser = createCopilotLineParser(absPath, cwdHint);
  for await (const line of rl) {
    offset += Buffer.byteLength(line, 'utf8') + 1;
    const entry = parser.pushLine(line);
    if (!entry) { tally.skipped++; continue; }
    const externalId = namespacedExternalId('copilot', entry.sessionId);
    const effectiveProject = entry.cwd ? projectSlug(entry.cwd) : project;
    await writeEntry(memory, sessionCache, bindingCache, externalId, effectiveProject, entry, absPath, tally);
  }
  const observedCwd = parser.observedCwd();
  if (observedCwd) memory.store.setMeta(`${COPILOT_CWD_PREFIX}${absPath}`, observedCwd);
}
```
- It's the **byte-cursor** path (shares `createReadStream(absPath, {start: startOffset})` + `writeCursor(offset)` at the end) — so it slots into the existing stream/`else` structure exactly like Codex (NOT the early-return Gemini block).
- Add `COPILOT_CWD_PREFIX = 'ingest:copilot-cwd:'` next to `CODEX_CWD_PREFIX`.
- **Compaction guard (the CRITICAL decision):** in `ingestSingleSession` (the `cursor >= size` check ~line 438), add: if `isCopilotTranscript(absPath) && cursor > size`, reset `cursor = 0` before calling `ingestFile` (file was rewritten by compaction/fork → re-sync; dedup `seen` + idempotent store write absorb the overlap). Test: write N events, ingest, simulate compaction by rewriting the file shorter-then-with-new-tail, re-ingest → new tail captured, no crash, no silent drop.

RED tests in `ingest.test.ts`: ingesting the Copilot fixture writes `copilot:<uuid>`-namespaced observations with the right project (from cached cwd), and a second ingest is a clean no-op (byte cursor at EOF).

### Task 6 — Adapter `src/harness/adapters/copilot.ts`
**File:** `src/harness/adapters/copilot.ts` (+ `.test.ts`). **Template:** `gemini.ts` (has `sessionEnd` capture) merged with the separator-style registrar.
```ts
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { copilotLifecycleInstaller } from '../capabilities/copilot-lifecycle-installer.js';
import { cliMcpRegistrar } from '../capabilities/mcp-registrar.js';
import { payloadFirstResolver } from '../capabilities/session-resolver.js';
import type { HarnessAdapter } from '../types.js';

export function copilotAdapter(): HarnessAdapter {
  const resolve = payloadFirstResolver();           // payload/path-only — no COPILOT_* session-id env
  const installer = copilotLifecycleInstaller();
  const registrar = cliMcpRegistrar({ binary: 'copilot' }); // DEFAULT separator style: `copilot mcp add … -- node <cli> start`
  return {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    mcpBinary: 'copilot',
    detect: async () => { try { await access(join(homedir(), '.copilot')); return true; } catch { return false; } },
    qualifies: () => ({ ok: true, missing: [] }),
    eventMap: {
      capture: ['SessionEnd'],                       // Copilot HAS sessionEnd (canonical-moment label)
      recall: ['SessionStart', 'UserPromptSubmit'],
      guard: ['PreToolUse'],
    },
    install: () => installer.install(),
    uninstall: () => installer.uninstall(),
    registerMcp: (cliPath, run) => registrar.register(cliPath, run),
    resolveSession: (input) => resolve(input),
  };
}
```
RED test mirrors `gemini.test.ts`: id/displayName/mcpBinary, `detect` true when `~/.copilot` exists (temp-home), `qualifies` ok, eventMap moments, MCP registrar uses `copilot` binary with separator style (assert the manual command string is `copilot mcp add agentbrainsystem -- node <cli> start`).

### Task 7 — Register in `defaultRegistry()`
**File:** `src/harness/index.ts` (+ extend `index.test.ts`, `registry.test.ts`).
```ts
import { copilotAdapter } from './adapters/copilot.js';
// ...
cached = createRegistry([claudeCodeAdapter(), codexAdapter(), geminiAdapter(), copilotAdapter()]);
```
RED: `defaultRegistry().byId('copilot')` is defined; `all()` has length 4; `detectInstalled()` includes copilot when `~/.copilot` exists.

### Task 8 — Live acceptance (DEFERRED on GitHub auth)
Document and attempt; do not block the merge on it (Gemini-precedent: API-key deferral).
- Auth: `gh auth login` or `COPILOT_GITHUB_TOKEN`. Then run `abs harness install copilot` (or the project's install entrypoint) and a real `copilot` session in a test repo.
- Verify on a populated `~/.copilot/session-state/<uuid>/events.jsonl`:
  1. The real `user.message`/`assistant.message` line shape matches the fixture (fix parser + fixture if not).
  2. `assistant.message.data.toolRequests[]` element schema → wire Edit/Write anchor mining for real (or confirm best-effort `[]` is acceptable for v1).
  3. The recall hook actually fires → confirms `userPromptSubmitted` vs `userPromptSubmit` config key (fix Task 3 key if needed).
  4. `transcript_path` on the hook stdin equals the events.jsonl path at fire time (else document the early-empty-path gap like Gemini did).
  5. `abs ingest --apply` produces `copilot:<uuid>` observations bucketed under the session's real cwd project.

---

## Reuse map (vs. variant)

| Concern | Decision |
|---|---|
| Namespacing | **Extend** the leaf (`isCopilotTranscript` + one `harnessForPayload` line). |
| Chokepoint / `namespacedExternalId` | **No change** (solved by #67). |
| MCP registrar | **Reuse** `cliMcpRegistrar({ binary: 'copilot' })` — default separator style, `--` accepted. No new code. |
| Hook installer | **Variant** `copilot-lifecycle-installer.ts` (Gemini template, but flat `event->[{type,bash}]` + `version:1`, target `~/.copilot/hooks.json`). |
| Transcript parser | **Variant** `copilot-jsonl.ts` (Codex stateful-parser template; `user.message`/`assistant.message` + cwd from `session.context_changed`). |
| Cursor model | **Reuse Codex byte-cursor** + one compaction `cursor>size ⇒ reset 0` guard. NOT Gemini's watermark. |
| Session resolver | **Reuse** `payloadFirstResolver()` (no session-id env). |
| Transcript-source | `jsonlTranscriptSource` already covers Copilot (it routes to `ingestSingleSession`, which now branches on path). |
| Adapter / registry | New `copilot.ts` + one line in `defaultRegistry`. |

## Validation
Each task: `npm run check`. Before any real-CLI smoke (`abs ...`): `npm run build` (dist is not rebuilt by `check`). Final: full `npm run check` green + Task-8 deferral noted.
