# Plan: OpenCode harness adapter (#72)

## Goal

Add **sst/opencode** (v1.15.10, Homebrew `/opt/homebrew/bin/opencode`) as the
**fifth** qualifying harness behind the mature Phase-0/`#67`–`#69` contract
(`src/harness/`). After this, `abs install-hooks --harness opencode` + `abs setup
--harness opencode` write an OpenCode **plugin file** + register the MCP server in
`opencode.json`; OpenCode sessions are captured + recalled through OpenCode's
native in-process plugin events; and OpenCode observations are namespaced
`opencode:` so they never collide with Claude (bare), Codex (`codex:`), Gemini
(`gemini:`) or Copilot (`copilot:`) session ids on one DB.

OpenCode is the **most architecturally divergent** adapter we have built. Every
prior adapter is a *shell-hook* harness reading a *per-session transcript file*;
the dispatch chokepoint (`src/hooks/dispatch.ts:60`) namespaces by
`payload.transcriptPath`, and `ingestSingleSession(transcriptPath)` is the seam.
**Neither applies to OpenCode**, because:

- **No shell hooks → in-process plugin.** Capture/recall fire *inside opencode's
  own Bun process* via a plugin module exporting `Hooks`. There is no `abs hook`
  invocation by OpenCode; instead **our plugin shells out to `abs`**.
- **No transcript file → SQLite.** History lives in
  `~/.local/share/opencode/opencode.db` (tables `session`/`message`/`part`). Ingest
  reads the DB by session id, not a JSONL/JSON file path.

So #72 does NOT extend `harnessForPayload` (there is no payload path to classify),
does NOT add a transcript-path regex to `namespacing.ts`, and does NOT route through
`ingestFile`. Instead it adds **two new capabilities** (a SQLite transcript source +
a plugin-event installer), **two new `abs` subcommands** the plugin calls, and an
adapter that composes them. The cross-cutting `namespacedExternalId(harnessId,
rawId)` helper *is* reused verbatim — the new subcommands namespace explicitly
because they KNOW they are OpenCode (they do not infer it from a path).

## Ground truth (OpenCode, verified on disk)

All facts below were read from the live v1.15.10 install on 2026-05-23 — the
`opencode` binary, the bundled plugin/SDK type defs in
`~/.config/opencode/node_modules/@opencode-ai/{plugin,sdk}` (plugin API **v1.14.24**,
stable against the 1.15.10 runtime), and the live store
`~/.local/share/opencode/opencode.db` (WAL mode, ~4.5 MB).

### Plugin load mechanism + export shape

A plugin is an ES module exporting a **`Plugin` function** that returns a `Hooks`
object. The exact contract (`@opencode-ai/plugin/dist/index.d.ts:36-56`):

```ts
export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>;
    project: Project;
    directory: string;          // the session cwd
    worktree: string;
    experimental_workspace: { register(type: string, adaptor: WorkspaceAdaptor): void };
    serverUrl: URL;
    $: BunShell;                // ← the shell-out bridge to `abs`
};
export type PluginOptions = Record<string, unknown>;
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
```

A plugin file therefore looks like `export const AbsPlugin: Plugin = async ({ $,
directory }) => ({ /* hooks */ })`. The bundled `dist/example-workspace.js` uses a
**default export** (`export default FolderWorkspacePlugin`); `dist/example.js` uses a
**named export** (`export const ExamplePlugin`). OpenCode accepts either — it imports
the module and reads every exported value that is a function. We will ship a single
**default export** for unambiguity.

**Discovery / load:** the config carries a `plugin` array. The SDK base config
(`@opencode-ai/sdk/dist/gen/types.gen.d.ts:1067`) types it as:

```ts
plugin?: Array<string>;
```

and the plugin package widens it (`index.d.ts:48-50`) to allow per-plugin options:

```ts
export type Config = Omit<SDKConfig, "plugin"> & {
    plugin?: Array<string | [string, PluginOptions]>;
};
```

Each entry is a **module specifier** — an npm package name OR a path to a local
`.js`/`.ts` file. There is also a CLI installer (`opencode plugin <module>` /
alias `plug`: *"install plugin and update config"*) and a filesystem auto-load dir
(`~/.config/opencode/plugin/` — note **singular**; the install also created an empty
`~/.config/opencode/plugins/` dir, which is NOT the load dir). **We use the config
`plugin` array pointing at a file we write**, because we control the file body (it
must shell to `abs`), the array is a stable typed surface, and it is idempotent +
reversible without invoking an interactive CLI.

### Hooks we use (exact type quotes)

`Hooks` (`index.d.ts:170-313`). The three surfaces this adapter wires:

```ts
export interface Hooks {
    event?: (input: { event: Event }) => Promise<void>;           // :171  CAPTURE + BIND
    "chat.message"?: (input: {                                     // :183  (observe, optional)
        sessionID: string; agent?: string;
        model?: { providerID: string; modelID: string };
        messageID?: string; variant?: string;
    }, output: { message: UserMessage; parts: Part[] }) => Promise<void>;
    "experimental.chat.system.transform"?: (input: {              // :261  RECALL inject
        sessionID?: string; model: Model;
    }, output: { system: string[] }) => Promise<void>;
}
```

The settle/lifecycle events arrive via the generic `event` bus. Exact property
shapes (`@opencode-ai/sdk/.../types.gen.d.ts`):

```ts
export type EventSessionIdle      = { type: "session.idle";      properties: { sessionID: string } }; // :413
export type EventSessionCompacted = { type: "session.compacted"; properties: { sessionID: string } }; // :419
export type EventSessionCreated   = { type: "session.created";   properties: { info: Session } };      // :493
export type EventSessionDeleted   = { type: "session.deleted";   properties: { info: Session } };       // :505
```

(`Event` is a 30-arm discriminated union, `types.gen.d.ts:602` — switch on
`event.type`.) `session.idle` carries **only `sessionID`** — the capture path
re-derives cwd/text from the DB by that id.

### The `$` shell bridge (plugin → abs)

`PluginInput.$` is a Bun shell (`@opencode-ai/plugin/dist/shell.d.ts`):

```ts
export interface BunShell {
    (strings: TemplateStringsArray, ...expressions: ShellExpression[]): BunShellPromise;
    escape(input: string): string;
    nothrow(): BunShell;
}
export interface BunShellPromise extends Promise<BunShellOutput> {
    quiet(): this;
    text(encoding?: BufferEncoding): Promise<string>;   // ← read abs stdout for recall
    nothrow(): this;
}
```

So the plugin shells out as a tagged template; **`$` auto-escapes interpolated
expressions** (`session.idle` → ``await $`abs opencode-capture --session ${sessionID}`.nothrow().quiet()``).
For recall it reads stdout: ``const text = await $`abs opencode-recall --session ${sessionID} --cwd ${directory}`.nothrow().text()``.
`.nothrow()` is mandatory on both — a non-zero `abs` exit must NEVER throw inside
opencode's event loop (ADR-0004 fail-open discipline, enforced inside the plugin too).

### opencode.db schema (live `.schema`, read-only)

```
CREATE TABLE `session` (
  `id` text PRIMARY KEY, `project_id` text NOT NULL, `parent_id` text,
  `slug` text NOT NULL, `directory` text NOT NULL,   -- cwd lives here
  `title` text NOT NULL, `version` text NOT NULL, ...,
  `time_created` integer NOT NULL, `time_updated` integer NOT NULL,
  `time_compacting` integer, `time_archived` integer, `workspace_id` text,
  `path` text, `agent` text, `model` text );
CREATE TABLE `message` (
  `id` text PRIMARY KEY, `session_id` text NOT NULL,
  `time_created` integer NOT NULL, `time_updated` integer NOT NULL,
  `data` text NOT NULL,                              -- JSON: { role, path:{cwd,root}, modelID, ... }
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE );
CREATE TABLE `part` (
  `id` text PRIMARY KEY, `message_id` text NOT NULL, `session_id` text NOT NULL,
  `time_created` integer NOT NULL, `time_updated` integer NOT NULL,
  `data` text NOT NULL,                              -- JSON: { type:"text", text:"…" } | step-start | reasoning | tool | step-finish | patch
  FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE );
```

Verified real rows:

- `session.id` = `ses_1e1ffd31affeOz4vj2gNwUXRRA`, `session.directory` =
  `/Users/vbjuliani/Devs/ChessTrainer` (the canonical cwd — **use this, not
  `message.data.path.cwd`**, which is empty on `user` messages).
- `part.id` = `prt_e1e002d3f001pX4L6nPLygXOxE`; `part.data` =
  `{ "type": "text", "text": "# Caveman Ultra — ativado\n…" }`. Distinct
  `part.data.type` seen: **`text`, `reasoning`, `tool`, `patch`, `step-start`,
  `step-finish`**. We keep `type == "text"` (prose); ignore the rest in v1.
- `message.data` = `{ "role": "assistant", "path": { "cwd": "/Users/…/ChessTrainer",
  "root": "…" }, "modelID": "glm-5.1", "time": { … } }` — `role` is the kind.
- **Ordering is monotonic.** In the busiest session, `part.time_created` is strictly
  ascending and the `prt_…` ids sort lexically in the same order. Reconstruct prose
  with: join `part`→`message` on `message_id`, filter `part.session_id = ?`, keep
  `part.data.type == 'text'`, `ORDER BY part.time_created ASC, part.id ASC`
  (the `, part.id` tiebreak makes the watermark deterministic when two parts share a
  millisecond). Map `role`/timestamp from the parent `message.data`/`message.time_created`.

### MCP registration method — FILE-ONLY (not the CLI)

`opencode mcp add` exists but is **interactive** — `opencode mcp add --help` shows
**no positional/flag args** (only the global `-h/--log-level/--pure`), i.e. it is a
prompt-driven wizard. So the `cliMcpRegistrar` pattern (`<cli> mcp add <name>
<cmd…>`, used by Claude/Codex/Copilot/Gemini) **cannot** be reused — spawning it
non-interactively would hang waiting on stdin.

MCP is therefore registered **file-only** by writing `opencode.json`. The config
schema (`types.gen.d.ts:1128-1130`, `946-969`):

```ts
mcp?: { [key: string]: McpLocalConfig | McpRemoteConfig };
export type McpLocalConfig = {
    type: "local";
    command: Array<string>;                 // command + args
    environment?: { [k: string]: string };
    enabled?: boolean;
    timeout?: number;                        // ms; default 5000
};
```

We write `config.mcp.agentbrainsystem = { type: "local", command: ["node",
"<cliPath>", "start"], enabled: true }` into `~/.config/opencode/opencode.json`
(matching how the other adapters spawn the server: `node <cli> start`). Current
real file is `{ "$schema": "https://opencode.ai/config.json" }` — we merge, never
clobber.

### Instruction file

OpenCode reads **`AGENTS.md`** natively (its instruction file); `config.instructions[]`
(`types.gen.d.ts:1162`) adds extra files/patterns. The repo `AGENTS.md` wrapper is
already aligned — no work here beyond noting it in the adapter doc.

## Architecture

The harness contract (`src/harness/types.ts`) is **unchanged** — `HarnessAdapter`
already abstracts `detect`/`qualifies`/`eventMap`/`install`/`uninstall`/`registerMcp`/
`resolveSession`. OpenCode fits the contract; only the *capabilities behind it* are new.

Two NEW capabilities (parallel to the existing `*-lifecycle-installer.ts` and
`transcript-source.ts`):

1. **`SqliteTranscriptSource`** (`src/harness/capabilities/sqlite-transcript-source.ts`)
   — read-only opencode.db reader. Reconstructs one session's text observations and
   writes them through the existing indexer, riding a **per-session part-id/time
   watermark** in `kv_meta` (at-least-once, never a silent drop). Replaces the
   `jsonlTranscriptSource`+`ingestSingleSession(path)` model for OpenCode.

2. **`PluginEventInstaller`** (`src/harness/capabilities/opencode-plugin-installer.ts`)
   — writes the plugin file into `~/.config/opencode/plugin/` and registers it in the
   `plugin` array of `opencode.json` (idempotent, backup-first, atomic, symlink-refusing
   — same safety machinery as the Gemini installer). Also owns the **file-only MCP
   registrar variant** (writes `config.mcp.agentbrainsystem`), since both edits touch
   the same `opencode.json` and must share one read-modify-atomic-write.

Two NEW `abs` subcommands the plugin shells to:

3. **`abs opencode-capture --session <ses_…>`** — ingest that session from the DB
   (the capture entry; calls capability #1).
4. **`abs opencode-recall --session <ses_…> --cwd <dir>`** — print the injected recall
   block to stdout (the recall entry; reuses `recallFts` + `renderRecallBlock`).

Plus the adapter (`src/harness/adapters/opencode.ts`) and registry wiring.

```
opencode (Bun process)
  │
  ├─ event: session.idle  ──$──▶  abs opencode-capture --session ses_…
  │                                 └─▶ SqliteTranscriptSource.ingest(memory, ses_…)
  │                                       └─▶ read opencode.db (RO) → indexer.write → watermark
  │
  ├─ event: session.created ──$──▶ abs opencode-capture (no-op bind; cwd already in DB)   [optional]
  ├─ event: session.deleted ──────▶ guard: plugin skips capture for that id
  │
  └─ experimental.chat.system.transform({sessionID})
        └─$──▶ abs opencode-recall --session ses_… --cwd <directory>
                 └─▶ recallFts(prompt-less, project-scoped) → renderRecallBlock → stdout
                       └─◀ output.system.push(text)   (mutable system array)
```

## TechStack

npm + Node ≥22 + TypeScript (ESM). Biome lint/format, Vitest, `tsc`. Validation:
`npm run check` (lint → typecheck → test). **Run `npm run build` before any live
`abs` test** (dist is NOT rebuilt by `check` — false-negatives otherwise). Reuse the
existing **`better-sqlite3`** dep (`package.json:42`) for the read-only DB open — no
new dependency. Worktree:
`/Users/vbjuliani/Devs/agentbrainsystem/.worktrees/h72`, branch
`feat/harness-opencode`, stacked on Phase0 + Codex + Gemini + Copilot.

## Where this BREAKS prior-adapter framework assumptions (read before coding)

1. **`harnessForPayload` cannot classify OpenCode.** It keys off
   `payload.transcriptPath` (`namespacing.ts:62`). OpenCode capture is NOT a hook with
   a payload + path — it is a plugin shelling `abs opencode-capture --session <id>`.
   → **Do NOT add an `isOpenCodeTranscript` regex or a `harnessForPayload` branch.**
   The new subcommands call `namespacedExternalId('opencode', sesId)` **directly**
   because they already know they are OpenCode. Claude/Codex/Gemini/Copilot stay byte-
   identical (zero regression).
2. **`ingestSingleSession(transcriptPath)` is path-shaped; OpenCode is id-shaped.** Do
   not force a fake path through it. The capture subcommand calls the new
   `SqliteTranscriptSource.ingest(memory, sesId)` directly.
3. **The byte/line cursor model does not apply.** opencode.db is a relational store,
   not an append log; there are no bytes to count. The watermark is the **last-ingested
   `part.id`** per session (id-anchored, like Gemini's id watermark — NOT Copilot's
   byte cursor).
4. **The CLI MCP registrar does not apply.** `opencode mcp add` is interactive; MCP is
   file-only. The adapter's `registerMcp` does NOT call `cliMcpRegistrar`; it returns a
   status from the file write (see Task 5).
5. **The dispatch chokepoint is bypassed.** `src/hooks/dispatch.ts` is the namespacing
   chokepoint for *hook* payloads. OpenCode never reaches it (it never calls `abs
   hook`). Namespacing happens at the new subcommands' boundary instead — the SAME
   `namespacedExternalId` function, a different call site.

---

## Tasks (bite-sized TDD — RED → GREEN → REFACTOR each)

### Task 1 — Namespacing: explicit `opencode:` tag, no path classifier

`src/ingest/namespacing.ts` already exports `namespacedExternalId(harnessId,
rawSessionId)` which prefixes any non-`claude-code` harness `<id>:`. So
`namespacedExternalId('opencode', 'ses_…')` → `'opencode:ses_…'` **with zero code
change**. The deliberate decision: **add NO `isOpenCodeTranscript` and NO
`harnessForPayload` branch** (there is no path to classify; see Break #1).

- **Test** (`src/ingest/namespacing.test.ts`, append): assert
  `namespacedExternalId('opencode', 'ses_abc') === 'opencode:ses_abc'`, and a
  regression assertion that `harnessForPayload({ transcriptPath: '/whatever' })`
  still returns `'claude-code'` for an opencode-looking path (proving we did NOT add
  a branch). RED is trivially green for the helper — the test exists to **lock the
  decision** so a future refactor doesn't "helpfully" add an opencode path branch.

### Task 2 — `SqliteTranscriptSource` capability (read-only DB ingest + watermark)

New file `src/harness/capabilities/sqlite-transcript-source.ts`. Exports
`sqliteTranscriptSource(options?)` returning `{ ingestSession(memory, sessionId):
Promise<IngestResult> }`.

**Open the DB read-only.** Use `better-sqlite3` with `{ readonly: true,
fileMustExist: true }` against `~/.local/share/opencode/opencode.db` (override via
option for tests). Set `PRAGMA query_only = 1` and **do not** open for write — honor
WAL concurrent writers. A vanished DB → empty `IngestResult` (fail-open).

**Reconstruct + write one session:**

```sql
SELECT p.id AS part_id, p.time_created AS p_time, p.data AS p_data,
       m.id AS msg_id, m.time_created AS m_time, m.data AS m_data,
       s.directory AS directory
FROM part p
JOIN message m ON m.id = p.message_id
JOIN session s ON s.id = p.session_id
WHERE p.session_id = ?
ORDER BY p.time_created ASC, p.id ASC;
```

For each row: parse `p.data` JSON, keep `type === 'text'` with non-empty `text`
(skip `reasoning`/`tool`/`patch`/`step-*` in v1 → counted `observationsSkipped`);
read `role` from `m.data.role` (default `'assistant'`); the cwd is `s.directory`
(canonical) → `projectSlug(directory)` for the effective project; `createdAt` from
`m.time_created`. Write through `memory.indexer.write({ sessionId: storeSessionId,
kind: role, content: text, source: 'opencode:' + sessionId, createdAt })` where
`storeSessionId` is resolved via the existing `resolveSession`/binding machinery —
**reuse `writeEntry` semantics** but parameterized for the DB row (no `ParsedEntry`
file abstraction). Externally namespace once:
`namespacedExternalId('opencode', sessionId)`.

**Watermark (at-least-once, id-anchored — the #67/#68/#69 dup class):**
`session.idle` re-fires on a growing session, so we MUST NOT re-read all parts.
Key: `kv_meta['opencode:cursor:' + sessionId]` = the **last-ingested `part.id`**.
On ingest:
1. Read the watermark id (null on first run).
2. Run the query (full session, ordered).
3. If a watermark exists, find its index in the result; start AFTER it. If the
   watermarked id is **absent** (history compacted/rewound past it →
   `session.compacted`), **re-sync from index 0** — at-least-once dup is the accepted
   #67/#68 store tolerance (`createObservation` is a plain INSERT, no ON CONFLICT),
   **never a silent drop**.
4. Write each new text part; after the loop, set the watermark to the LAST text
   part's id seen (or leave unchanged if none were new → idempotent on an unchanged
   session — `session.idle` fired but nothing grew).

This is the exact discipline of the Gemini `GEMINI_LASTID_PREFIX` watermark
(`ingest.ts:317-342`), translated from "message id in a parsed JSON array" to
"part id in a SQL result set". Mirror its re-sync-not-drop comment verbatim.

- **Tests** (`sqlite-transcript-source.test.ts`): build a temp SQLite with the EXACT
  opencode schema (3 tables, the real column lists above) and seed rows. Cover:
  (a) cold ingest of a 2-message/3-text-part session → 3 observations under
  `opencode:ses_…`, project derived from `session.directory`;
  (b) **at-least-once cursor** — re-run with no new parts → 0 added (watermark holds);
  (c) **incremental** — append 2 parts, re-run → exactly 2 added (rides watermark);
  (d) **re-sync on rewind** — delete the watermarked part, re-run → re-syncs from 0
  (dups tolerated, no drop);
  (e) non-text parts (`reasoning`/`tool`/`step-start`) skipped, counted
  `observationsSkipped`;
  (f) missing DB file → empty result, no throw;
  (g) read-only: the source NEVER writes to the opencode.db (assert mtime/size
  unchanged, or open the test DB readonly and confirm no error).

### Task 3 — `PluginEventInstaller` capability + the plugin file template

New file `src/harness/capabilities/opencode-plugin-installer.ts`. Exports
`opencodePluginInstaller(options?)` returning a `LifecycleInstaller`
(`{ install(): Promise<InstallReport>; uninstall(): Promise<UninstallReport> }`,
the existing capability interface). Owns BOTH the plugin file AND the
`opencode.json` `plugin`-array edit (and Task 5's MCP edit shares the same writer).

Options: `configDir` (default `~/.config/opencode`), `pluginFileName` (default
`agentbrainsystem.js`), `absBinary` (default `'abs'` — the command the plugin
shells; injectable for tests/non-PATH installs).

**Install:**
1. `assertNotSymlink` + atomic-write the plugin file to
   `<configDir>/plugin/<pluginFileName>` (create `plugin/` dir if missing). The file
   body is the template below, with `__ABS__` substituted by `absBinary`.
2. Read `<configDir>/opencode.json` (or `{}` if absent/malformed → preserve user
   bytes via backup), parse JSON, ensure `plugin` array contains
   `"./plugin/<pluginFileName>"` (relative module specifier — opencode resolves it
   from the config dir). Idempotent: skip if already present.
3. Backup-first (only when something changed), atomic temp+rename, mode 0o600.
4. Return `{ wired: ['capture', 'recall'] }` (guard is implicit — handled in-plugin
   via `session.deleted`, not a separate wired moment).

**Uninstall:** remove our plugin-array entry (drop the `plugin` key if it becomes
empty), delete the plugin file (only if it is ours — match by filename), backup-first.
Return `{ removed: [...moments] }`. Leave the user's other plugins + MCP servers
untouched (the MCP entry is removed by `cmdUninstall`'s MCP unregister path, Task 5).

**The plugin file template** (written verbatim, `__ABS__` → `absBinary`). It is a
hand-authored `.js` ESM module (NOT compiled from TS — it runs in opencode's Bun
runtime, not ours):

```js
// agentbrainsystem — OpenCode capture + recall bridge (managed by `abs`; do not edit).
// Capture: on session.idle, ingest the session from opencode.db into abs memory.
// Recall : on system-prompt transform, inject abs-recalled memory into the system array.
// Fail-open: every shell-out is .nothrow() so a non-zero `abs` exit never blocks opencode.
export const AbsPlugin = async ({ $, directory }) => {
  const deleted = new Set();
  return {
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        deleted.add(event.properties.info.id);
        return;
      }
      if (event.type === "session.idle" || event.type === "session.compacted") {
        const id = event.properties.sessionID;
        if (deleted.has(id)) return;                       // GUARD: never ingest a tombstoned session
        await $`__ABS__ opencode-capture --session ${id}`.nothrow().quiet();
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const text = await $`__ABS__ opencode-recall --session ${input.sessionID} --cwd ${directory}`
        .nothrow().quiet().text();
      const block = text.trim();
      if (block) output.system.push(block);                // RECALL inject (mutable system[])
    },
  };
};
export default AbsPlugin;
```

(`$` auto-escapes `${id}`/`${directory}`/`${input.sessionID}` — no manual quoting.
`.quiet()` suppresses echo; `.text()` reads stdout for the recall block.)

- **Tests** (`opencode-plugin-installer.test.ts`): point `configDir` at a temp dir.
  Cover: (a) install writes `plugin/agentbrainsystem.js` containing the template with
  `absBinary` substituted, and adds `"./plugin/agentbrainsystem.js"` to
  `opencode.json` `plugin[]`; (b) **idempotency** — second install is a no-op (no dup
  array entry, byte-stable file, no extra backup); (c) preserves an existing
  unrelated plugin entry + the `$schema` key; (d) uninstall removes our entry + file,
  leaves the user's plugin; (e) symlink `opencode.json` → refuse to write;
  (f) malformed `opencode.json` → backup taken, fresh write, user bytes recoverable.

### Task 4 — New `abs` subcommands: `opencode-capture` + `opencode-recall`

`src/cli/cli.ts`: add two cases to the command switch (`cli.ts:1119`) +
`cmdOpencodeCapture(rest)` / `cmdOpencodeRecall(rest)`. Add both to `USAGE`.

**`abs opencode-capture --session <ses_…>`:**
- Parse `--session` (required; missing → exit 1, printed error).
- `const memory = await openMemory()` (default ensure gate — a drifted index
  self-heals, same as `handleSessionEnd`).
- `await sqliteTranscriptSource().ingestSession(memory, sessionId)` in a
  `try { } finally { memory.close(); }`.
- Print nothing on success (the plugin `.quiet()`s it); errors go to stderr, exit 0
  on fail-open is NOT used here (the *plugin* is the fail-open boundary via
  `.nothrow()`), but a clean non-zero exit on a hard error is fine because the plugin
  swallows it. Keep it simple: success → exit 0; ingest throw → stderr + exit 1.

**`abs opencode-recall --session <ses_…> --cwd <dir>`:**
- Parse `--session` (required) + `--cwd` (required — the project scope source).
- `const memory = await openMemory(config, { ensure: false })` (read-only fast path,
  NO model cold-load — same discipline as `handleUserPromptSubmit`, ADR-0005).
- The system-transform hook has **no user prompt** (it shapes the system prompt, not
  a turn query). So recall is a **project-broad** pull, not prompt-scoped: resolve the
  project from `--cwd` via `resolveRecallProject(store, { cwd, sessionId:
  'opencode:'+ses, scope })` and pull the project's most-recent/most-relevant
  observations. v1: `recallFts` needs a query string; with no prompt we pull the
  project's recent durable observations directly (a thin `store.recentByProject(project,
  TOP_K)` read, or reuse `recallFts` with the project slug words as the query). Render
  with the existing `renderRecallBlock(hits, fenceHeader(project))` so the injected
  text is byte-compatible with the per-prompt hook's fenced block (prompt-injection
  hygiene preserved).
- Print the rendered block to **stdout** (the plugin reads it via `.text()`); empty →
  print nothing. Always `memory.close()` in `finally`.

> **Design note (recall query source):** the cleanest v1 is project-recent recall
> (no prompt available at system-transform time). If a future opencode API exposes
> the pending user message to the transform hook, switch to prompt-scoped `recallFts`
> — the subcommand surface (`--session`/`--cwd` + optional `--prompt`) is forward-
> compatible. Add `--prompt` now as optional: when present, `recallFts(prompt, …)`;
> when absent, project-recent. The plugin omits it in v1.

- **Tests** (`src/cli/cli.test.ts`, append): (a) `opencode-capture` with a temp DB +
  temp store → observations land under `opencode:ses_…`; (b) `opencode-capture`
  missing `--session` → exit 1; (c) `opencode-recall --cwd <proj>` with seeded
  observations → prints a fenced `<recalled-memory>` block scoped to the project;
  (d) `opencode-recall` empty store → prints nothing, exit 0; (e) `opencode-recall`
  missing `--session`/`--cwd` → exit 1.

### Task 5 — `src/harness/adapters/opencode.ts` + file-only MCP registrar

New file. Composes Tasks 2/3 + a **file-only MCP registrar**.

```ts
export function opencodeAdapter(): HarnessAdapter {
  const installer = opencodePluginInstaller();
  return {
    id: 'opencode',
    displayName: 'OpenCode',
    mcpBinary: 'opencode',                 // for messaging only; MCP is file-written, not CLI
    detect: async () => {
      // opencode on PATH OR ~/.config/opencode present (mirrors codex/gemini/copilot)
      try { await access(join(homedir(), '.config', 'opencode')); return true; }
      catch { return await onPath('opencode'); }
    },
    qualifies: () => ({ ok: true, missing: [] }),   // all four pillars verified (ADR-0011)
    eventMap: {
      capture: ['session.idle', 'session.compacted'],   // settle + flush-before-compact
      recall:  ['experimental.chat.system.transform'],  // native per-turn system inject
      guard:   ['session.deleted'],                      // tombstone guard (in-plugin)
    },
    install: () => installer.install(),
    uninstall: () => installer.uninstall(),
    registerMcp: async () => fileMcpRegister(),    // writes config.mcp.agentbrainsystem
    resolveSession: (input) => input.payload?.sessionId
      ? { sessionId: input.payload.sessionId } : null,   // id-only; no transcript path, no env
  };
}
```

**`fileMcpRegister()`** (lives in the installer module, shares its `opencode.json`
read-modify-atomic-write): merge `config.mcp.agentbrainsystem = { type: 'local',
command: ['node', cliPath, 'start'], enabled: true }`. Idempotent: if an identical
entry exists → `{ status: 'already' }`; if a *different* server already owns the
`agentbrainsystem` key → leave it, return `{ status: 'already' }` (never clobber);
on write → `{ status: 'registered' }`; symlink/permission error →
`{ status: 'error', message, manualCommand }` where `manualCommand` is a
copy-pasteable JSON snippet (NOT a `opencode mcp add` line — that's interactive).
The adapter's `registerMcp(cliPath, run)` ignores `run` (no subprocess) and calls
this; `cliPath` is threaded so the command array points at the real installed CLI.

> The `HarnessAdapter.registerMcp(cliPath, run)` signature is unchanged — OpenCode
> simply doesn't use `run`. This is a clean fit: the contract abstracts *intent*
> (register MCP), not *mechanism* (CLI vs file). Document the divergence in the
> adapter header like the Gemini/Copilot adapters document theirs.

- **Tests** (`src/harness/adapters/opencode.test.ts`): (a) `id`/`displayName`/
  `eventMap` shape; (b) `qualifies()` ok; (c) `detect()` true when `~/.config/opencode`
  exists (temp HOME), false otherwise; (d) `resolveSession` returns `{sessionId}` from
  payload, null without; (e) `registerMcp` writes `config.mcp.agentbrainsystem` into a
  temp `opencode.json`, idempotent on second call, never clobbers a foreign entry.

### Task 6 — Register in `defaultRegistry()`

`src/harness/index.ts`: import `opencodeAdapter` and add it as the **fifth** entry in
`createRegistry([...])`. Update `src/harness/index.test.ts` /
`src/harness/registry.test.ts` expectations (count 4 → 5; `byId('opencode')` resolves;
`opencode` in `all()`). This makes `abs install-hooks --harness opencode` /
`abs setup --harness opencode` / `abs uninstall --harness opencode` resolve the adapter
through the existing `resolveHarnesses` flow (`cli.ts:372`) with **no CLI change** for
install/uninstall/setup — they already dispatch by `--harness <id>`.

### Task 7 — Test fixtures + suite

- Add a temp-SQLite fixture builder under
  `src/harness/capabilities/__fixtures__/opencode-db.ts` that `CREATE`s the exact 3
  tables and exposes `seedSession({ id, directory, parts: [{role, text, time}] })`.
  Reuse it across Task 2 + Task 4 + Task 5 tests so the schema is asserted in ONE
  place (drift-proof). Optionally include a tiny **real** opencode.db slice (read-only
  copy of a single benign session) as a smoke fixture, gated to skip if absent.
- `npm run check` green (lint → typecheck → all suites). Confirm the 4 prior adapters'
  tests are byte-unchanged (zero regression — we touched only additive surfaces +
  the registry count).

### Task 8 — Live acceptance (opencode v1.15.10 installed)

`npm run build` FIRST (dist staleness landmine). Then, non-interactively where
feasible:

1. **Install:** `abs install-hooks --harness opencode` + `abs setup --harness opencode`
   → assert `~/.config/opencode/plugin/agentbrainsystem.js` exists with the substituted
   `abs` binary, `opencode.json` has both the `plugin` entry and
   `mcp.agentbrainsystem`. Back up the real `opencode.json` first; restore after.
2. **Capture (DB→memory) without driving a live LLM session:** point
   `abs opencode-capture --session <an existing real ses_… from opencode.db>` at the
   live DB → assert observations land under `opencode:ses_…` with the project derived
   from that session's `directory` (e.g. `ChessTrainer`). This exercises the full
   capture path against REAL data with no auth/model dependency.
3. **Recall:** `abs opencode-recall --session <ses_…> --cwd /Users/…/ChessTrainer` →
   assert a fenced `<recalled-memory>` block prints scoped to that project.
4. **End-to-end plugin (best-effort, NOTE deps):** a fully live capture+inject loop
   needs an authenticated provider + model to drive a real opencode turn
   (`auth.json` present, but model/network out of scope for an offline acceptance).
   Document this as the one manual step; the DB-direct capture (step 2) + recall
   (step 3) prove every seam EXCEPT opencode's own event firing, which is the
   plugin-template + `$` bridge already unit-tested in Task 3. Note the
   `experimental.` namespace pin (ADR-0011 watch-out) — add a comment in the plugin
   file recording the tested opencode version range (1.15.x).
5. **Cleanup:** `abs uninstall --harness opencode` → plugin file + config entries
   removed; restore the backed-up `opencode.json`.

## Risks / watch-outs

- **`session.idle` dup storm (the #67/#68/#69 class).** Mitigated by the id-anchored
  part-id watermark (Task 2). The watermark MUST tiebreak on `part.id` after
  `time_created` — two parts in the same millisecond would otherwise make "start after
  the watermark" ambiguous. Tested in Task 2(b/c/d).
- **`experimental.` API churn.** `chat.system.transform` / `chat.messages.transform`
  live under `experimental.` (ADR-0011). Pin the tested version (1.15.x) in the plugin
  file header + adapter doc; the plugin fails open (`.nothrow()`) if the hook is
  renamed, so a version bump degrades to "no injection", never a crash.
- **WAL concurrent writers.** Open the DB `{ readonly: true }` + `PRAGMA query_only`;
  never write. opencode keeps writing during a session — a read-only handle tolerates
  it. Tested in Task 2(g).
- **`opencode mcp add` is interactive — do NOT shell it.** MCP is file-only (Break #4).
  A reviewer expecting `cliMcpRegistrar` reuse must read this section.
- **Plugin dir is `plugin/` (singular).** The installer also-saw an empty `plugins/`
  dir; the load dir referenced by relative `plugin[]` specifiers and the CLI is
  `plugin/`. We use the explicit `plugin[]` array entry so dir-name ambiguity is moot.
- **`message.data.path.cwd` is empty on user messages.** Always use `session.directory`
  for the project (Task 2). Tested via the fixture's `directory` column.
- **Do not regress the chokepoint.** Adding an opencode path branch to
  `harnessForPayload` would be wrong (Break #1) — Task 1's regression test guards it.

## Done when

- `npm run check` green; 4 prior adapters' tests byte-unchanged.
- `abs setup --harness opencode` writes plugin + MCP config idempotently; `abs
  uninstall --harness opencode` reverses it.
- `abs opencode-capture` ingests a real opencode.db session under `opencode:ses_…`
  scoped to the session's real `directory`; re-running adds nothing (watermark holds).
- `abs opencode-recall` prints a project-scoped fenced recall block.
- `defaultRegistry()` returns 5 adapters; `--harness opencode` resolves.
- Adapter + two capabilities + plugin template documented (header comments) with the
  on-disk facts + the tested opencode version range.

## Task count: 8
