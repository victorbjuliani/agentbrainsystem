---
type: adr
title: "ADR 0011 — OpenCode parity spike: does sst/opencode qualify for full memory parity?"
description: "OpenCode parity spike: can sst/opencode reach full memory parity?"
timestamp: 2026-05-23T01:23:36-03:00
status: accepted
---

# ADR 0011 — OpenCode parity spike: does sst/opencode qualify for full memory parity?

**Status:** accepted · **Date:** 2026-05-23 · Spike for: #70 · Feeds: #72 (adapter)

## Context

agentbrainsystem ships a memory layer (capture → embed → persist → recall) wired into a
host agent harness via lifecycle hooks plus an MCP stdio tool surface. Claude Code and
Codex already qualify for **full parity** because each exposes the same four capabilities,
even though the concrete mechanisms differ (Claude shell hooks `Stop`/`SessionEnd` +
per-prompt injection; Codex equivalents). Issue #70 asks whether **sst/opencode**
(installed v1.15.10 at `/opt/homebrew/bin/opencode`, real Homebrew install) clears the
same gate before we commit engineering to a #72 adapter.

### Parity gate (all four required)

A harness qualifies for full parity ONLY if it exposes ALL of:

1. **Automatic CAPTURE trigger** — a lifecycle mechanism that fires when a turn/session
   settles, so memory can be extracted without the user asking.
2. **Automatic RECALL injection** — a mechanism to inject recalled context into the model's
   input before it answers.
3. **MCP stdio tools** — ability to register a local stdio MCP server so the `remember`/
   `recall`/`forget`/etc. tools are callable.
4. **Stable session id + readable transcript on disk** — a durable id and a parseable
   per-message history (role, content, timestamp, cwd) the ingest path can read.

Mechanism may differ from Claude/Codex; a plugin event system counts as a lifecycle
mechanism. This ADR records what was verified **on disk against the real install**, not
from documentation or memory.

## Four-pillar findings (real evidence)

All evidence is from the live install: the `opencode` binary CLI, the bundled plugin/SDK
type definitions in `~/.config/opencode/node_modules/@opencode-ai/{plugin,sdk}` (plugin
API v1.14.24, stable against the 1.15.10 runtime), and the live SQLite store at
`~/.local/share/opencode/opencode.db`.

### Pillar 1 — Automatic CAPTURE trigger — PRESENT

OpenCode has a first-class **plugin event system**, not just shell hooks. A plugin is a
module exporting a `Plugin` function returning a `Hooks` object
(`@opencode-ai/plugin/dist/index.d.ts:51,170`). Two independent capture surfaces exist:

- **Generic event bus** — `Hooks.event?: (input: { event: Event }) => Promise<void>`
  (`index.d.ts:171`). The `Event` union (`@opencode-ai/sdk` `types.gen.d.ts`) includes the
  full session lifecycle: `session.created` (`:493`), `session.idle` (`:413`),
  `session.compacted` (`:419`), `session.deleted` (`:505`), plus `message.updated` (`:129`)
  and `message.part.updated` (`:354`).
- **Settle signal** — `EventSessionIdle.properties = { sessionID }` (`types.gen.d.ts:413`)
  fires when the agent finishes a turn and the session goes quiet. This is the natural
  capture point — the OpenCode analogue of Claude's `Stop` / Codex's session-settle hook.
- **Per-message hook** — `Hooks["chat.message"]` ("Called when a new message is received",
  `index.d.ts:183`) gives `{ sessionID }` plus the `UserMessage` and its `Part[]` directly,
  a second capture/observe point that does not require reading the DB.

A plugin can run arbitrary Node/Bun code in these handlers (it receives `client`, `$`
shell, `project`, `directory`, `worktree` via `PluginInput`, `index.d.ts:36`), so capture
can shell out to `abs ingest` or call the store directly.

### Pillar 2 — Automatic RECALL injection — PRESENT

`Hooks["experimental.chat.system.transform"]` (`index.d.ts:261`):

```
"experimental.chat.system.transform"?: (
  input: { sessionID?: string; model: Model },
  output: { system: string[] }
) => Promise<void>;
```

The hook receives the **mutable system-prompt array** and the `sessionID`, and runs before
the model is called. A plugin recalls memories for the session's project and pushes them
into `output.system` — a native per-turn injection mechanism, directly equivalent to
Claude's per-prompt context injection. (A secondary path,
`experimental.chat.messages.transform` at `:255`, can rewrite the whole message list if
injection-as-a-message is ever preferred.) `instructions?: Array<string>` in the config
(`types.gen.d.ts:1159`) offers a static-file fallback, but the system-transform hook is the
dynamic, per-session mechanism that satisfies the pillar.

### Pillar 3 — MCP stdio tools — PRESENT

The CLI exposes `opencode mcp add | list | auth | logout | debug` (`opencode mcp --help`).
The config schema defines a local (stdio) MCP server type, `McpLocalConfig`
(`types.gen.d.ts:946`):

```
type: "local";
command: Array<string>;          // command + args to launch the stdio MCP server
environment?: { [k: string]: string };
```

registered under `config.mcp[<name>]` (`types.gen.d.ts:1128-1130`, value is
`McpLocalConfig | McpRemoteConfig`). So the agentbrainsystem stdio server registers exactly
as it does for Claude/Codex — e.g. `mcp.agentbrainsystem = { type: "local", command:
["abs", "mcp"] }` in `opencode.json`. `opencode mcp list` against the real install confirms
the surface is live ("No MCP servers configured. Add servers with: opencode mcp add").

### Pillar 4 — Stable session id + readable transcript — PRESENT

At v1.15.10 the JSON→SQLite migration is **complete**: the transcript lives in
`~/.local/share/opencode/opencode.db` (SQLite, ~4.5 MB live, WAL mode). Only `session_diff`
and `migration` remain as loose JSON under `storage/`; messages do not. Verified schema
(`sqlite3 opencode.db .schema`):

- **`session`** — PK `id` (`ses_…`, stable opaque id), plus `project_id`, `slug`,
  **`directory`** (the cwd — project binding lands here), `title`, `version`,
  `time_created`, `time_updated`, `time_compacting`, `time_archived`. Real row:
  `ses_1e1ffd31affeOz4vj2gNwUXRRA | … | mighty-canyon | /Users/vbjuliani/Devs/ChessTrainer | Caveman Ultra ativado | 1778619788517 | 1778621302222`.
- **`message`** — PK `id` (`msg_…`), FK `session_id`, `time_created`, `data` (JSON).
  Sample `data`: `{ "role": "assistant", "agent": "build", "path": {"cwd": "…", "root":
  "…"}, "modelID": "glm-5.1", "providerID": "opencode-go", "time": {"created": …,
  "completed": …}, "tokens": {…} }` — role, model, cwd, timestamps all present.
- **`part`** — PK `id`, FK `message_id` + `session_id`, `data` (JSON). Content lives here as
  typed parts: `{ "type": "text", "text": "…" }`, plus `step-start` / `step-finish`
  bookkeeping parts. Live counts: 13 sessions / 223 messages / 999 parts.

So a stable session id (`ses_…`), per-message role/timestamp/cwd, and the full text body
(message → parts) are all readable on disk. The id is also addressable via the CLI
(`opencode session list|delete`, `opencode export <sessionID>`, `--session <id>`).

**Instruction file:** OpenCode reads `AGENTS.md` (its native instruction file), and
`config.instructions[]` adds extra instruction files/patterns (`types.gen.d.ts:1159`) — the
project's `AGENTS.md` wrapper is already aligned.

## Decision — VERDICT

**QUALIFIES for full parity.** All four pillars are present and verified against the real
v1.15.10 install. The mechanism differs from Claude/Codex shell hooks (OpenCode uses an
in-process plugin event system over its HTTP/SDK server), but the gate explicitly allows
plugin events to count, and every required capability has an on-disk, type-checked surface.

No pillar is missing. No workaround is required. The only mechanism gap vs. shell-hook
harnesses is that capture/recall run **inside a plugin process** rather than as external
hook scripts — which is strictly more capable (the plugin gets `client`, `$`, project, and
directory in one closure).

### Proposed event-map for the #72 adapter

| OpenCode native surface | Role | Notes |
| --- | --- | --- |
| `chat.message` hook (`index.d.ts:183`) | RECALL trigger / per-prompt | fires on each new user message with `sessionID` + parts; pairs with the system transform below |
| `experimental.chat.system.transform` (`index.d.ts:261`) | RECALL inject | push recalled memories into mutable `output.system: string[]`; keyed by `input.sessionID` → `session.directory` → project |
| `event` → `session.idle` (`types.gen.d.ts:413`) | CAPTURE | turn-settled signal; trigger ingest of the session's new messages |
| `event` → `session.compacted` (`:419`) | CAPTURE (flush) | capture before history is summarized away |
| `event` → `session.created` (`:493`) | project BIND | `properties.info.directory` is the cwd → bind session to project (analogue of ADR-0010 session→project binding) |
| `event` → `session.deleted` (`:505`) | GUARD | drop/skip if a session is deleted before ingest |
| `chat.params` / `permission.ask` (`:199`, `:221`) | GUARD (optional) | could gate writes, not required for parity |

- **Transcript format + path:** SQLite at `~/.local/share/opencode/opencode.db`, tables
  `session` / `message` / `part` (schema above). Read path: join `part`→`message` on
  `message_id`, filter `message.session_id = <ses_…>`, order by `time_created`; parse
  `part.data` JSON, keep `type == "text"`; map role/timestamp from `message.data`.
- **Transcript schema sample (one text part):**
  `part.data = { "type": "text", "text": "Todas as fases implementadas. 681 testes…" }`;
  parent `message.data = { "role": "assistant", "path": {"cwd": "/Users/…/ChessTrainer"},
  "modelID": "glm-5.1", "time": {"created": 1778621294485, "completed": …} }`.
- **Session-id source:** `session.id` (`ses_…`), the SQLite PK. Available in every hook as
  `input.sessionID` and in `EventSessionCreated.properties.info.id`. Stable across the
  session; no mtime-guessing needed (contrast with Claude's transcript-by-mtime hazard).
- **Project binding:** `session.directory` (DB column) / `info.directory`
  (`EventSessionCreated`) / `message.data.path.cwd|root` — three concordant cwd sources,
  same model as ADR-0010.
- **MCP registration:** `config.mcp.agentbrainsystem = { type: "local", command: ["abs",
  "mcp"], environment: {…} }` in `opencode.json` (project or `~/.config/opencode/`).
- **Namespace tag:** `opencode:` (parallel to `claude:` / `codex:`).
- **Plugin install:** ship the adapter as an npm module; `opencode plugin <module> [-g]`
  installs it and updates config. Plugins also load from `~/.config/opencode/plugins/` and
  the per-project `.opencode/plugin/` dir.

## Consequences

- **Positive:** #72 can build a single OpenCode plugin that does capture (`session.idle`),
  recall (`chat.message` + `system.transform`), and project binding (`session.created`) in
  one process, plus an MCP stdio registration — full parity with Claude/Codex. The stable
  `ses_…` id removes the mtime ambiguity that complicates the Claude path.
- **Watch-outs for #72 (not parity blockers):**
  - Recall hooks live under the `experimental.` namespace (`chat.system.transform`,
    `chat.messages.transform`); the API may rename/stabilize across OpenCode versions — pin
    a tested version range and add a smoke test.
  - The bundled plugin/SDK types are v1.14.24 while the runtime is v1.15.10; build the
    adapter against the version the runtime resolves, not the snapshot read here.
  - Ingest must read SQLite (WAL mode) **read-only** and tolerate concurrent writes; do not
    open the DB for write. Honor `session.deleted` to avoid ingesting tombstoned sessions.
  - `session.idle` can fire multiple times per session (each settle); ingest must ride a
    per-session byte/row cursor (at-least-once), same discipline as the Claude path.
