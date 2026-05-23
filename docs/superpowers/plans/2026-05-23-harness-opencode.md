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
**named export** (`export const ExamplePlugin`) — both shapes ship in the SDK
examples, so we **ship both a named (`AbsPlugin`) and a default export for loader
compatibility** rather than betting on one. The exact rule the (minified) opencode
loader uses to pick exported plugin functions is **not verified** from the bundle, so
we do not assert it as fact; the dual export is the safe hedge and is **smoke-tested
in Task 8 acceptance** against the real runtime.

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

### Config file is JSONC — resolution order + parse rule (CRITICAL, verified in the binary)

OpenCode's config is **JSONC**, not plain JSON. Read straight out of the 1.15.10
binary (`strings /opt/homebrew/bin/opencode`):

```js
// config resolution — JSONC FIRST, then .json, then config.json:
["opencode.jsonc","opencode.json","config.json"].map((Z)=>P2.join(l.Path.config,Z));
for (let Z of $) if (rW(Z)) return Z;   // rW = existsSync
return $[0]                              // none exist → DEFAULT is "opencode.jsonc"
```

Two hard facts this proves:

1. **Precedence is `opencode.jsonc` → `opencode.json` → `config.json`.** If the user
   has an `opencode.jsonc`, it WINS. Writing `opencode.json` in that case means our
   `mcp`/`plugin` keys are written to a file opencode never reads → MCP + plugin
   silently never load. (And the "create if none exist" default is `opencode.jsonc`,
   not `.json`.)
2. **Any resolved config is parsed as JSONC, not `JSON.parse`.** The binary bundles
   the full `jsonc-parser` library: the tokenizer with `allowTrailingComma`, the
   `ParseErrorCode` enum (`InvalidSymbol`/`PropertyNameExpected`/…), and the
   `modify`/`applyEdits` editor (`nx`/`ox`/`px` with
   `formattingOptions:{insertSpaces,tabSize}`) that opencode uses to edit its OWN
   config in place while preserving comments. So a user's `opencode.json` may legally
   contain `// comments` and trailing commas — and `JSON.parse` THROWS on it.

**Why the Gemini "malformed → start fresh (preserve via backup)" rule is WRONG here.**
The Gemini installer (`gemini-lifecycle-installer.ts:90-97`) does
`try { JSON.parse(...) } catch { return {} }` — a comment/trailing-comma config falls
into the `catch`, so the installer would serialize a fresh `{}`-derived object and
**overwrite the user's entire JSONC config** (a `.bak` exists, but the live file is
clobbered — exactly what C1 forbids). Gemini's `settings.json` is plain JSON so the
rule is safe there; opencode's is not. We need a JSONC-aware, **abort-not-clobber**
write path (defined under "Config write strategy" below and used by Tasks 3 + 5).

> **Dep decision (dep-free default).** opencode itself uses `jsonc-parser` for
> lossless edit-preservation, and adding it (a tiny, zero-dep, widely-vetted package)
> would let us *edit* a JSONC config without clobbering. But the project ethos is
> minimal deps (CLAUDE.md / ADR-0001), and the safe behaviour does NOT require it:
> we can strict-`JSON.parse` the happy path and **abort to a printed manual-merge
> snippet** on any JSONC file we can't losslessly round-trip. So **v1 ships dep-free**
> (no `jsonc-parser`); the abort path is the correctness guarantee. A future task MAY
> add `jsonc-parser` to upgrade abort→auto-edit, but it is explicitly out of #72.

### Config write strategy (shared by the plugin-array edit AND the MCP edit)

Both `opencode.json`-touching edits (plugin array, Task 3; `mcp` key, Task 5) go
through ONE shared helper `editOpencodeConfig(configDir, mutate)` in the installer
module. Steps:

1. **Target-file detection — match opencode's precedence.** In `configDir`, pick the
   FIRST that exists of `opencode.jsonc`, `opencode.json`, `config.json`; if none
   exists, target `opencode.json` (we deliberately create plain `.json`, not
   `.jsonc` — we only ever write strict JSON, see step 3). The chosen path is the
   read+write target; `assertNotSymlink` it first (refuse symlinks, Gemini precedent).
2. **Read + parse strategy.**
   - Empty/absent file → start from `{}` (safe: nothing to lose).
   - Non-empty file → **strict `JSON.parse`**.
     - **Parse SUCCEEDS** (plain JSON) → run `mutate(config)` (adds/merges our
       `mcp.agentbrainsystem` and/or `plugin[]` entry, preserving every other key),
       then backup-first + atomic temp+rename write of `JSON.stringify(next,null,2)+'\n'`
       (mode 0o600), exactly like the Gemini installer's safe path. No-op detection:
       if the serialized output equals the bytes read, return without backup/write.
     - **Parse FAILS** (the file is JSONC: comments / trailing commas / JSON5) →
       **DO NOT WRITE.** Take a backup (defensive), then ABORT with a structured
       result `{ status: 'manual', targetPath, snippet }` whose `snippet` is the
       exact JSON to paste — e.g. for MCP (the `<cliPath>` placeholder is the SAME
       threaded `cliPath` `fileMcpRegister(cliPath)` received — the absolute installed
       `cli.js`, NOT bare `abs`, NOT the installer module path; C2):
       `"mcp": { "agentbrainsystem": { "type": "local", "command": ["node","<cliPath>","start"], "enabled": true } }`
       and for the plugin: `"plugin": ["./plugin/agentbrainsystem.js"]`. The caller
       (installer / `fileMcpRegister`) surfaces this as a printed manual-merge
       instruction — the SAME degrade-to-manual pattern the MCP registrar already
       uses for the `unavailable`/printed-command case. The user's config is left
       **byte-for-byte unchanged**.

This is the project's minimal-deps-honoring, lossless-or-abort contract: we never
overwrite a non-empty config we cannot round-trip. (If a later task adds
`jsonc-parser`, only the "Parse FAILS" branch changes — abort becomes a
`modify`/`applyEdits` in-place edit; everything else stays.)

> **Wnew — collision-proof backup filename (same-ms `.bak` overwrite).** `abs setup
> --harness opencode` (`cmdSetup`) calls `registerMcp` (writes the `mcp` key) THEN
> `install` (writes the `plugin[]` entry) — TWO `editOpencodeConfig` edits against the
> SAME `opencode.json` in the same run. The Gemini backup helper this writer copies
> names backups `${path}.${new Date().toISOString().replace(/[:.]/g,'-')}.bak`
> (`gemini-lifecycle-installer.ts:104`) — ISO-**millisecond** granularity. Two edits
> inside one millisecond produce the SAME `.bak` name, so the second backup
> **overwrites the first** → the `.bak` reflects the post-MCP-edit state, NOT the
> user's original pre-setup config. (No live-file data loss — the second
> read-merge-write sees the first edit's result, so the live `opencode.json` is
> correct — but the `.bak` no longer recovers the true original: a rough edge.)
>
> **Fix (collision-proof backup name — chosen over the single-write merge because it's
> a one-liner and keeps the two-edit flow + correct MCP status reporting intact):**
> `editOpencodeConfig`'s backup helper appends a per-process monotonic discriminator,
> mirroring the temp-file naming already in the same module
> (`.abs-gemini-tmp-${Date.now()}-${process.pid}`, `gemini-lifecycle-installer.ts:109`).
> Backup name becomes
> `${path}.${new Date().toISOString().replace(/[:.]/g,'-')}.${process.pid}-${counter++}.bak`
> where `counter` is a module-scoped integer bumped on every backup — so two same-ms
> edits in one process get distinct `.bak` files and the FIRST (containing the true
> original) is never clobbered. (This new backup helper lives in the opencode installer
> module; the existing `gemini-lifecycle-installer.ts` `backupSettings` is NOT touched —
> zero regression to the 4 prior adapters.)
> - **Test (Task 5):** after a full `abs setup --harness opencode` against a temp plain
>   `opencode.json` (the real two-edit path), assert that a `.bak` exists whose content
>   equals the ORIGINAL pre-setup config bytes (the first backup survives), and the live
>   `opencode.json` contains BOTH `mcp.agentbrainsystem` and the `plugin[]` entry.

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
"<cliPath>", "start"], enabled: true }` (matching how the other adapters spawn the
server: `node <cli> start`) into the **resolved** config file via
`editOpencodeConfig` (see "Config write strategy" above) — `opencode.jsonc` if it
exists, else `opencode.json`, else create `opencode.json`. We merge plain-JSON
configs in place (never clobber other keys); a JSONC config aborts to a printed
manual snippet. The current real file is plain JSON
(`{ "$schema": "https://opencode.ai/config.json" }`) so the happy path applies.

### Instruction file

OpenCode reads **`AGENTS.md`** natively (its instruction file); `config.instructions[]`
(`types.gen.d.ts:1162`) adds extra files/patterns. The repo `AGENTS.md` wrapper is
already aligned — no work here beyond noting it in the adapter doc.

## Architecture

The harness contract (`src/harness/types.ts`) gets ONE additive change — `install()`
becomes `install(cliPath: string)` (C2; see below). Everything else
(`detect`/`qualifies`/`eventMap`/`uninstall`/`registerMcp`/`resolveSession`) is
unchanged. OpenCode fits the contract; only the *capabilities behind it* are new.

> **C2 contract change — `install(cliPath)` (mirror `registerMcp(cliPath, run)`).**
> Today `HarnessAdapter.install()` (`types.ts:74`) takes NO argument, and the two call
> sites (`cmdInstallHooks` `cli.ts:405`, `cmdSetup` `cli.ts:482`) call
> `adapter.install()` with nothing. The opencode plugin must bake the ABSOLUTE
> `node <cli.js>` path into the generated plugin file, and the ONLY correct source of
> that path is the CLI entrypoint's own `fileURLToPath(import.meta.url)` —
> `cmdSetup` already computes exactly this as `const cliPath` at `cli.ts:463` and
> threads it into `registerMcp(cliPath, ...)`. Deriving the path from
> `import.meta.url` *inside the installer/capability module* is WRONG: after `tsc` that
> resolves to `dist/harness/capabilities/opencode-plugin-installer.js`, not
> `dist/cli/cli.js` — the baked plugin would shell `node <installer.js> opencode-capture`,
> a path with no CLI dispatcher, and because every plugin shell-out is `.nothrow()` the
> failure is silently swallowed → capture + recall dead. So we THREAD `cliPath` through
> `install()` exactly as `registerMcp` already does (option a — the registerMcp-consistent
> fix; NOT a walk-up from the installer's own `import.meta.url`).
>
> **Mechanical changes (Task 6a — contract + the 4 existing adapters + 2 call sites):**
> - `types.ts:74`: `install(cliPath: string): Promise<InstallReport>;`
> - The four existing adapters (`claude-code.ts:40`, `codex.ts:42`, `gemini.ts:46`,
>   `copilot.ts:46`) change `install: () => installer.install()` →
>   `install: (_cliPath) => installer.install()` — accept-and-IGNORE the arg (their
>   settings.json / config.toml installers don't bake a CLI path; `_cliPath` is unused).
>   This is a typecheck-only no-op for them — their existing tests stay byte-green.
> - `cli.ts` call sites: `cmdSetup` already has `const cliPath = fileURLToPath(import.meta.url)`
>   at `:463` (above `registerMcp`); the `adapter.install()` at `:482` becomes
>   `adapter.install(cliPath)` reusing the SAME const (no new compute, no second
>   `fileURLToPath`). `cmdInstallHooks` (`:401-415`) has NO cliPath in scope today, so
>   hoist `const cliPath = fileURLToPath(import.meta.url)` to the top of `cmdInstallHooks`
>   (the `fileURLToPath` import already exists for `:463`) and call
>   `adapter.install(cliPath)` at `:405`.

Two NEW capabilities (parallel to the existing `*-lifecycle-installer.ts` and
`transcript-source.ts`):

1. **`SqliteTranscriptSource`** (`src/harness/capabilities/sqlite-transcript-source.ts`)
   — read-only opencode.db reader. Reconstructs one session's text observations and
   writes them through the existing indexer, riding a **per-session part-id/time
   watermark** in `kv_meta` (at-least-once, never a silent drop). Replaces the
   `jsonlTranscriptSource`+`ingestSingleSession(path)` model for OpenCode.

2. **`PluginEventInstaller`** (`src/harness/capabilities/opencode-plugin-installer.ts`)
   — writes the plugin file (with the ABSOLUTE `node <cliPath>` invocation baked in,
   C2) into `~/.config/opencode/plugin/` and registers it in the `plugin` array of the
   **resolved** opencode config (idempotent, backup-first, atomic, symlink-refusing).
   Also owns the **file-only MCP registrar variant** (writes
   `config.mcp.agentbrainsystem`), since both edits touch the same config file and
   share ONE `editOpencodeConfig` helper — the **JSONC-aware, abort-not-clobber**
   write path (precedence-ordered target detection + strict-parse-or-abort, C1; see
   "Config write strategy"), NOT the Gemini "malformed → start fresh" rule.

Two NEW `abs` subcommands the plugin shells to:

3. **`abs opencode-capture --session <ses_…>`** — ingest that session from the DB
   (the capture entry; calls capability #1).
4. **`abs opencode-recall --session <ses_…> --cwd <dir>`** — print the injected recall
   block to stdout (the recall entry; project-recent `listObservations` +
   `renderRecallBlock`, plus a once-per-session consent notice — see Task 4).

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
                 └─▶ listObservations({project, order:desc, limit:TOP_K})
                       → [once/session] renderNotice prepend → renderRecallBlock → stdout
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
`opencodePluginInstaller(options?)` returning a capability whose
`install(cliPath: string): Promise<InstallReport>` takes the threaded CLI path and
whose `uninstall(): Promise<UninstallReport>` is arg-free. Owns BOTH the plugin file
AND the `opencode.json` `plugin`-array edit (and Task 5's MCP edit shares the same
writer; `fileMcpRegister(cliPath)` takes the same threaded path).

Options: `configDir` (default `~/.config/opencode`), `pluginFileName` (default
`agentbrainsystem.js`), and `nodePath` (default `process.execPath`) for the node
binary baked into the plugin. The **`cliPath` is NOT an option / NOT defaulted from
`import.meta.url`** — it is the REQUIRED argument to `install(cliPath)`, threaded from
the CLI entrypoint (`cli.ts:463`; see C2). Also an `absCommand` override (default
`undefined`) so a test can inject a single fake command string in place of the
`${nodePath} ${cliPath}` pair; **the shipped default is the absolute
`node <cliPath>` pair, NEVER bare `abs`** — see C2 below.

> **C2 — the plugin MUST bake the ABSOLUTE invocation, not bare `abs`, sourced from
> `cli.js` (NOT the installer module).** The plugin runs inside opencode's own **Bun**
> process, frequently launched from a GUI / launchd context whose `PATH` does NOT
> include the npm-global bin dir. A bare ``$`abs …` `` then resolves to nothing, and
> because every shell-out is `.nothrow()`, the failure is **silently swallowed** →
> capture + recall dead with no error.
>
> The ONLY correct source of the absolute `cli.js` path is the CLI entrypoint's own
> `fileURLToPath(import.meta.url)`. Computing it inside THIS installer module is a trap:
> after `tsc`, this module's `import.meta.url` is `dist/harness/capabilities/opencode-plugin-installer.js`,
> NOT `dist/cli/cli.js` — the baked plugin would shell `node <installer.js> opencode-capture`,
> a module with no CLI dispatcher (the `switch (cmd)` lives in `cli.ts`), so capture+recall
> die silently. So `install(cliPath)` RECEIVES the path the CLI already threads into
> `registerMcp(cliPath, ...)` (`cli.ts:463-464`, where `import.meta.url` IS `cli.js`).
> We capture `nodePath = process.execPath` and that threaded `cliPath` **at install
> time** and write both as `JSON.stringify(...)` string literals into the plugin file,
> so the generated plugin shells the absolute
> ``$`${nodePath} ${cliPath} opencode-capture --session ${id}` ``. No PATH dependency,
> no installer-module-path bug.

**Install (`install(cliPath)`):**
1. `assertNotSymlink` + atomic-write the plugin file to
   `<configDir>/plugin/<pluginFileName>` (create `plugin/` dir if missing). The file
   body is the template below, with `__NODE__`/`__CLI__` substituted by `nodePath` and
   the threaded `cliPath` argument (or, if `absCommand` is given for a test, the single
   token replaces the `${nodePath} ${cliPath}` pair). Both substituted values are
   wrapped in `JSON.stringify(...)` so a path containing spaces is a valid,
   correctly-quoted JS string literal in the emitted module.
2. Edit the resolved config file via `editOpencodeConfig` (see "Config write
   strategy"): ensure `plugin` array contains `"./plugin/<pluginFileName>"` (relative
   module specifier — opencode resolves it from the config dir). Idempotent: skip if
   already present. JSONC config → abort to printed manual snippet (config unchanged).
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
// CONSENT: opencode never calls `abs hook`, so the user is told their sessions are
//   being captured INSIDE the recall block — the abs CLI prepends a one-time memory
//   notice on the first recall of each session (see opencode-recall, Task 4). Opt out
//   with `abs project --session opencode:<id> --skip` (run from the session's project
//   dir — see the adapter doc for the cwd note).
// Absolute invocation: the plugin runs in opencode's Bun process whose PATH may lack
//   the npm-global bin, so it shells the ABSOLUTE `node <cli.js>` pair baked at
//   install time (NOT bare `abs`) — otherwise .nothrow() would silently swallow a
//   PATH miss and capture/recall would be dead.
// Tested against opencode 1.15.x (plugin API 1.14.24; experimental.* surface).
// Fail-open: every shell-out is .nothrow() so a non-zero `abs` exit never blocks opencode.
export const AbsPlugin = async ({ $, directory }) => {
  const deleted = new Set();
  const lastCap = new Map();                               // sessionID → last capture epoch ms (W1 debounce)
  const NODE = __NODE__;                                   // process.execPath, JSON-stringified literal
  const CLI = __CLI__;                                     // absolute cli.js path, JSON-stringified literal
  return {
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        deleted.add(event.properties.info.id);
        return;
      }
      if (event.type === "session.idle" || event.type === "session.compacted") {
        const id = event.properties.sessionID;
        if (deleted.has(id)) return;                       // GUARD: never ingest a tombstoned session
        const now = Date.now();                            // W1: debounce idle storm — skip if <10s since last
        if (now - (lastCap.get(id) ?? 0) < 10000) return;  //     capture for this id (avoids per-idle cold-load)
        lastCap.set(id, now);
        await $`${NODE} ${CLI} opencode-capture --session ${id}`.nothrow().quiet();
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const text = await $`${NODE} ${CLI} opencode-recall --session ${input.sessionID} --cwd ${directory}`
        .nothrow().quiet().text();
      const block = text.trim();
      if (block) output.system.push(block);                // RECALL inject (mutable system[])
    },
  };
};
export default AbsPlugin;
```

(`$` auto-escapes `${NODE}`/`${CLI}`/`${id}`/`${directory}`/`${input.sessionID}` — no
manual quoting. `.quiet()` suppresses echo; `.text()` reads stdout for the recall
block. The W1 in-plugin debounce — track last-capture epoch per session in a `Map`,
skip a re-fire within 10 s — keeps a `session.idle` storm from cold-loading the
embedding model on a fresh node process every few seconds; capture is already
off-the-critical-path (`.nothrow().quiet()`) so the worst case is a delayed capture,
never a block. W3: this module ships BOTH a named (`AbsPlugin`) and a default export
for loader compatibility (the minified opencode loader's exact value-enumeration
rule is unverified); the live smoke-test in Task 8 is what actually proves the export
shape against real opencode.)

- **Tests** (`opencode-plugin-installer.test.ts`): point `configDir` at a temp dir.
  Cover: (a) `install(cliPath)` writes `plugin/agentbrainsystem.js` containing the
  template with the ABSOLUTE `node <cliPath>` pair substituted — assert the file
  contains the passed `process.execPath` + the EXACT `cliPath` arg (e.g. an absolute
  `/…/dist/cli/cli.js`), and **NOT** bare `abs` AND **NOT** any
  `opencode-plugin-installer.js` / `capabilities/` path (C2 regression guard — proves
  the path is threaded, not derived from this module's `import.meta.url`);
  (b) **idempotency** — second install is a no-op (no dup array entry,
  byte-stable file, no extra backup); (c) preserves an existing unrelated plugin entry
  + the `$schema` key in a **plain-JSON** `opencode.json`; (d) uninstall removes our
  entry + file, leaves the user's plugin; (e) symlink config → refuse to write;
  (f) **C1 — plain `opencode.json`** with other keys → `mcp`/`plugin` added, other
  keys preserved; (g) **C1 — `opencode.jsonc` present** (alongside or instead of
  `.json`) → THAT file is the edit target (assert the `.jsonc` file changed and a
  sibling `.json` was not created/clobbered); (h) **C1 — JSONC `.json`** (a `.json`
  file containing `// comment` + trailing comma) → installer ABORTS: file
  byte-UNCHANGED (not clobbered), a `.bak` was taken, and the printed manual snippet
  contains the exact `plugin[]` (and, via Task 5, `mcp.agentbrainsystem`) JSON.

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
  a turn query), so recall is a **project-recent** pull, not prompt-scoped.
- **W2 — commit to ONE real recall mechanism (no `recentByProject`, no slug-words
  hedge).** `store.recentByProject` does NOT exist; FTS-with-project-slug-words is a
  degenerate query. The real method is `MemoryStore.listObservations`
  (`memory-store.ts:363`), which takes `{ project, order, limit }`:
  1. `const project = resolveRecallProject(memory.store, { scope: 'project',
     sessionId: 'opencode:' + ses, cwd })` (binding/stored-project wins, else
     `projectSlug(cwd)` — `scope.ts:42-60`).
  2. `const obs = memory.store.listObservations({ project, order: 'desc',
     limit: TOP_K })` — the project's most-recent observations, newest first, no
     model load (FTS/vector untouched; this is a plain indexed `SELECT … ORDER BY id
     DESC LIMIT`). Reuse the existing recall `TOP_K` constant.
  3. Map to the renderer's hit shape: `const hits = obs.map((observation) =>
     ({ observation, score: 0 }))` (`RecallHit` requires `observation` + `score`,
     `recall.ts:31`; `score` is unused by `renderRecallBlock`).
  4. `renderRecallBlock(hits, fenceHeader(project))` (`user-prompt-submit.ts:105`)
     so the injected text is byte-compatible with the per-prompt hook's fenced block
     (prompt-injection hygiene preserved).
- **C3 — consent notice, injected once per session.** opencode never calls `abs
  hook`, so `renderNotice` (`session-start.ts:98`) never fires and the user is never
  told their sessions are captured. Fix: on the FIRST `opencode-recall` for a session,
  PREPEND the notice to the returned block. Reuse the first-prompt-flag machinery
  (`consumeFirstPromptFlag`/`NOTICE_FLAG_PREFIX`, `user-prompt-submit.ts:53,61`):
  `consumeFirstPromptFlag` keys `kv_meta['notice-shown:' + sid]` and returns true
  exactly once per `sid` — so calling it with `sid = 'opencode:' + ses` reuses the
  EXACT same helper (no parallel copy needed) and the opencode `notice-shown:opencode:<ses>`
  key cannot collide with a Claude key. When it returns true, call
  `renderNotice('opencode:' + ses, cwd)` and prepend the notice (a blank line between
  notice and recall block). Second+ recall for the same session → flag already set →
  no notice. (If the store is opened `{ ensure: false }` read-only, the one-time
  `setMeta` write inside `consumeFirstPromptFlag` still works — `kv_meta` is a normal
  table; confirm the read-only open still permits the meta write, else open the meta
  write path explicitly. Tested below.)
- Print the rendered block (notice + recall) to **stdout** (the plugin reads it via
  `.text()`); empty (no notice this turn AND no observations) → print nothing.
  Always `memory.close()` in `finally`.

> **Opt-out (document explicitly — adapter header + this plan).** The skip command
> works for opencode: `abs project --session opencode:<id> --skip` (`cmdProject`
> resolves `--session` to override the ambient id via `resolveSessionId(args)`,
> `cli.ts:914`). **Caveat:**
> `cmdProject` hard-codes `const cwd = process.cwd()` (`cli.ts:926`) and `--cwd` is
> already taken as an ACTION flag there (`cli.ts:888` — "file this session under its
> folder"), so adding a `--cwd <path>` *override* would collide with the existing
> action surface. **Decision: do NOT add `--cwd` to `cmdProject` in #72** (the
> collision makes it not-cheap and risks regressing the existing skip/file UX). Instead
> **document the requirement**: the user must run `abs project --session opencode:<id>
> --skip` **from the session's project directory** (so `process.cwd()` resolves to the
> right project). The renderNotice text already names the project folder, and the
> consent block will state this cwd requirement for opencode. (A clean `--cwd`
> override is a candidate follow-up, tracked separately.)

> **Design note (recall query source):** project-recent recall is the v1 mechanism
> (no prompt available at system-transform time). If a future opencode API exposes
> the pending user message to the transform hook, add an optional `--prompt` and
> switch to prompt-scoped `recallFts(prompt, { project })` when present — the
> subcommand surface stays forward-compatible. v1 does not add `--prompt`.

- **Tests** (`src/cli/cli.test.ts`, append): (a) `opencode-capture` with a temp DB +
  temp store → observations land under `opencode:ses_…`; (b) `opencode-capture`
  missing `--session` → exit 1; (c) `opencode-recall --cwd <proj>` with seeded
  observations → prints a fenced `<recalled-memory>` block scoped to the project, via
  `listObservations({ project, order:'desc', limit:TOP_K })` (assert it returns the
  project's recent observations); (d) `opencode-recall` empty store → prints nothing,
  exit 0; (e) `opencode-recall` missing `--session`/`--cwd` → exit 1; (f) **consent**:
  the FIRST `opencode-recall` for a session includes the `renderNotice` text prepended
  to the block; a SECOND call for the same session does NOT (flag consumed); (g) the
  notice fires even on an otherwise-empty recall (notice alone is printed on the first
  turn).

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
      // ~/.config/opencode present (mirrors gemini/copilot one-liner exactly — there
      // is NO `onPath` helper in this codebase; the 4 existing adapters' detect() is
      // just access(~/.config-dir)+catch→false, N1).
      try { await access(join(homedir(), '.config', 'opencode')); return true; }
      catch { return false; }
    },
    qualifies: () => ({ ok: true, missing: [] }),   // all four pillars verified (ADR-0011)
    eventMap: {
      capture: ['session.idle', 'session.compacted'],   // settle + flush-before-compact
      recall:  ['experimental.chat.system.transform'],  // native per-turn system inject
      guard:   ['session.deleted'],                      // tombstone guard (in-plugin)
    },
    install: (cliPath) => installer.install(cliPath),    // C2: thread cliPath → baked absolute node <cli.js>
    uninstall: () => installer.uninstall(),
    registerMcp: (cliPath) => fileMcpRegister(cliPath),  // C2: same threaded path → mcp.command ["node", cliPath, "start"]
    resolveSession: (input) => input.payload?.sessionId
      ? { sessionId: input.payload.sessionId } : null,   // id-only; no transcript path, no env
  };
}
```

**`fileMcpRegister(cliPath)`** (lives in the installer module, goes through the SAME
`editOpencodeConfig` helper as the plugin-array edit — JSONC-aware, abort-not-clobber,
C1): merge `config.mcp.agentbrainsystem = { type: 'local', command: ['node', cliPath,
'start'], enabled: true }` into the resolved config file. Idempotent: if an identical
entry exists → `{ status: 'already' }`; if a *different* server already owns the
`agentbrainsystem` key → leave it, return `{ status: 'already' }` (never clobber);
on write → `{ status: 'registered' }`; **JSONC config that strict-parse fails** →
`{ status: 'manual', message, manualCommand }` where `manualCommand` is the
copy-pasteable `mcp.agentbrainsystem` JSON snippet to paste (NOT an `opencode mcp add`
line — that's interactive), config left byte-unchanged; symlink/permission error →
`{ status: 'error', message }`. The adapter's `registerMcp(cliPath, run)` ignores
`run` (no subprocess) and calls this; `cliPath` is threaded so the command array
points at the real installed CLI.

> The `HarnessAdapter.registerMcp(cliPath, run)` signature is unchanged — OpenCode
> simply doesn't use `run`. This is a clean fit: the contract abstracts *intent*
> (register MCP), not *mechanism* (CLI vs file). Document the divergence in the
> adapter header like the Gemini/Copilot adapters document theirs.

- **Tests** (`src/harness/adapters/opencode.test.ts`): (a) `id`/`displayName`/
  `eventMap` shape; (b) `qualifies()` ok; (c) `detect()` true when `~/.config/opencode`
  exists (temp HOME), false otherwise; (d) `resolveSession` returns `{sessionId}` from
  payload, null without; (e) `registerMcp` writes `config.mcp.agentbrainsystem` into a
  temp plain `opencode.json`, idempotent on second call, never clobbers a foreign
  entry; (f) **C1** — `registerMcp` against a JSONC `.json` (comment/trailing comma)
  → `{ status: 'manual' }`, config byte-unchanged, snippet contains the mcp entry;
  (g) **C1** — when `opencode.jsonc` exists, `registerMcp` targets it (not `.json`);
  (h) **Wnew — backup not clobbered by the two-edit setup**: drive the real
  `cmdSetup`-equivalent two edits (registerMcp THEN install) against a temp plain
  `opencode.json`, then assert a `.bak` exists whose bytes EQUAL the original pre-setup
  config (the first backup survived the same-ms second edit), and the live file has
  BOTH `mcp.agentbrainsystem` and the `plugin[]` entry;
  (i) **C2 — `registerMcp(cliPath)` bakes the threaded path**: the written
  `mcp.agentbrainsystem.command` is `["node", <the cliPath arg>, "start"]` — assert the
  exact passed `cliPath`, NOT bare `abs`.

### Task 6 — Register in `defaultRegistry()`

`src/harness/index.ts`: import `opencodeAdapter` and add it as the **fifth** entry in
`createRegistry([...])`. Update `src/harness/index.test.ts` /
`src/harness/registry.test.ts` expectations (count 4 → 5; `byId('opencode')` resolves;
`opencode` in `all()`). `abs install-hooks --harness opencode` /
`abs setup --harness opencode` / `abs uninstall --harness opencode` resolve the adapter
through the existing `resolveHarnesses` flow (`cli.ts:372`) — they already dispatch by
`--harness <id>`. The ONLY CLI change is the C2 `install(cliPath)` threading at the two
call sites (`cmdInstallHooks` `cli.ts:405`, `cmdSetup` `cli.ts:482`) plus the contract
edit in `types.ts:74` and the 4 prior adapters' accept-and-ignore signature — covered
in the C2 contract-change block under "Architecture" (do that mechanical change as part
of this task: contract + 4 adapters + 2 call sites, typecheck-only no-op for the four).

### Task 7 — Test fixtures + suite

- Add a temp-SQLite fixture builder under
  `src/harness/capabilities/__fixtures__/opencode-db.ts` that `CREATE`s the exact 3
  tables and exposes `seedSession({ id, directory, parts: [{role, text, time}] })`.
  Reuse it across Task 2 + Task 4 + Task 5 tests so the schema is asserted in ONE
  place (drift-proof). Optionally include a tiny **real** opencode.db slice (read-only
  copy of a single benign session) as a smoke fixture, gated to skip if absent.
- `npm run check` green (lint → typecheck → all suites). Confirm the 4 prior adapters'
  tests still pass byte-unchanged (zero regression). NOTE the ONE non-additive edit:
  the C2 contract change `install(cliPath)` touches `types.ts:74` + the 4 adapters'
  `install` signature (accept-and-ignore `_cliPath`; their `installer.install()` body
  call is unchanged). This is safe-by-construction: the ONLY two zero-arg
  `adapter.install()` call sites in the whole tree are `cli.ts:405` + `cli.ts:482`, and
  C2 updates BOTH to `adapter.install(cliPath)` — so no zero-arg adapter call remains to
  fail typecheck. The 4 adapters' test files call the capability `installer.install()`
  directly (signature untouched), NOT `adapter.install()`, so they are byte-green. (TS
  would reject a zero-arg call to a one-required-param `install`, which is exactly why
  both call sites MUST be updated in the same change — not optional.)

### Task 8 — Live acceptance (opencode v1.15.10 installed)

`npm run build` FIRST (dist staleness landmine). Then, non-interactively where
feasible:

1. **Install:** `abs install-hooks --harness opencode` + `abs setup --harness opencode`
   → assert `~/.config/opencode/plugin/agentbrainsystem.js` exists with the ABSOLUTE
   `node <abs-cli.js>` invocation baked in (NOT bare `abs` — C2), and the resolved
   config file (`opencode.json` here, plain JSON) has both the `plugin` entry and
   `mcp.agentbrainsystem`. Back up the real `opencode.json` first; restore after.
   (The live file is plain JSON, so this exercises the happy path; the JSONC abort
   path is unit-tested in Tasks 3/5.)
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
   plugin-template + `$` bridge already unit-tested in Task 3. When the manual loop is
   run, it is also the **live smoke-test of the dual export shape** (W3 — confirm the
   real opencode loader actually loads the `AbsPlugin`/default-export module and fires
   the hooks) and of the **consent notice** appearing on the session's first injected
   system prompt (C3). Note the `experimental.` namespace pin (ADR-0011 watch-out) —
   the plugin file already records the tested opencode version range (1.15.x).
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
- **Config is JSONC, not JSON (C1).** Resolution precedence is
  `opencode.jsonc → opencode.json → config.json` (verified in the binary), and any
  resolved config is parsed as JSONC (comments + trailing commas legal). The Gemini
  "malformed → start fresh" rule would CLOBBER a JSONC config; we use the
  strict-parse-or-abort `editOpencodeConfig` helper instead (Tasks 3/5). Tested:
  plain JSON merges in place, `.jsonc` is the target when present, a JSONC `.json`
  aborts to a printed manual snippet with the file unchanged.
- **Plugin shells the ABSOLUTE `node <cli.js>`, never bare `abs`, sourced from the
  CLI entrypoint not the installer module (C2).** opencode's Bun process PATH may lack
  the npm-global bin; bare `abs` + `.nothrow()` = silent dead capture/recall. The path
  MUST come from `cli.ts`'s `fileURLToPath(import.meta.url)` — deriving it inside the
  installer module resolves to `dist/harness/capabilities/opencode-plugin-installer.js`
  after `tsc` (no CLI dispatcher there) and is equally dead. Fix: thread `cliPath`
  through `install(cliPath)` (contract change, `types.ts:74`) exactly as
  `registerMcp(cliPath, run)` already does; `cmdInstallHooks`/`cmdSetup` pass the
  `cli.ts:463` `cliPath`. The 4 prior adapters accept-and-ignore the arg. Tested:
  generated plugin contains the absolute `node <cli.js>` command, NOT `abs` and NOT any
  `capabilities/`/installer-module path.
- **`abs setup --harness opencode` double-edits one `opencode.json` → `.bak`
  collision (Wnew).** `cmdSetup` runs `registerMcp` then `install`, two
  `editOpencodeConfig` edits in the same run; the Gemini-style ISO-millisecond `.bak`
  name collides on a same-ms second edit and overwrites the first (the one holding the
  user's true original). No live-file loss, but the backup is wrong. Fix: the opencode
  installer's backup helper appends `${process.pid}-${counter++}` (mirroring the
  module's temp-file naming) so same-ms backups get distinct names; the existing
  `gemini-lifecycle-installer.ts` helper is untouched. Tested: post-setup `.bak` equals
  the original pre-setup config.
- **Consent for opencode (C3).** opencode never calls `abs hook` → `renderNotice`
  never fires natively. The notice is injected once per session by `opencode-recall`
  (first-transform, via `consumeFirstPromptFlag` keyed `opencode:<ses>`). Opt-out is
  `abs project --session opencode:<id> --skip` run from the session's project dir
  (cwd requirement documented; no `--cwd` override added — collides with the existing
  action flag). Tested: first recall shows the notice, second does not.
- **Capture cold-loads the embedding model per `session.idle` (W1).** Each capture is
  a fresh node process that can't memoize the transformers.js pipeline, so a
  `session.idle` storm would reload it repeatedly. Capture is off the critical path
  (`.nothrow().quiet()`), so this is tolerable, but the plugin DEBOUNCES: skip a
  re-capture within 10 s of the last for that session (per-session `Map` of last-cap
  epoch). Worst case is a delayed capture, never a block.
- **One real recall method (W2).** Recall uses `MemoryStore.listObservations({
  project, order:'desc', limit:TOP_K })` (`memory-store.ts:363`) — a real,
  no-model-load indexed read — NOT the non-existent `store.recentByProject` and NOT a
  degenerate slug-words FTS query. Mapped to `RecallHit[]` (`{observation, score:0}`)
  for `renderRecallBlock`.
- **Dual export is a hedge, not a verified fact (W3).** The plugin ships both a named
  (`AbsPlugin`) and a default export for loader compatibility; the exact rule the
  minified opencode loader uses is unverified, so the real proof is the Task 8 live
  smoke-test, not an assertion.

## Done when

- `npm run check` green; 4 prior adapters' tests byte-unchanged.
- `abs setup --harness opencode` writes plugin + MCP config idempotently; `abs
  uninstall --harness opencode` reverses it.
- `abs opencode-capture` ingests a real opencode.db session under `opencode:ses_…`
  scoped to the session's real `directory`; re-running adds nothing (watermark holds).
- `abs opencode-recall` prints a project-scoped fenced recall block via
  `listObservations` (W2), with the consent notice prepended on the session's first
  recall and suppressed thereafter (C3).
- The generated plugin shells the absolute `node <cli.js>` invocation, not bare `abs`
  and not the installer module path (C2 — `cliPath` threaded through `install(cliPath)`
  + `fileMcpRegister(cliPath)` from `cli.ts:463`; contract `types.ts:74` updated; the 4
  prior adapters accept-and-ignore the arg, tests still green); config writes are
  JSONC-safe — plain JSON merges in place, JSONC aborts to a printed manual snippet with
  the user's file unchanged (C1).
- `abs setup --harness opencode`'s two-edit run leaves a `.bak` that recovers the user's
  true pre-setup config (Wnew — collision-proof per-process backup filename).
- `defaultRegistry()` returns 5 adapters; `--harness opencode` resolves.
- Adapter + two capabilities + plugin template documented (header comments) with the
  on-disk facts, the consent/opt-out story, and the tested opencode version range.

## Task count: 8

(8 tasks unchanged. Round-2 plan-critic fixes added tests inside existing tasks — Task
3 gains the C1 JSONC + C2 absolute-path cases [+3], Task 4 gains the C3 consent cases
[+2] and the W2 real-method assertion, Task 5 gains the C1 JSONC/precedence MCP cases
[+2]. Round-3 plan-critic fixes: C2 corrected from "derive in installer" to "thread
`cliPath` through `install()`" — a contract change (`types.ts`) + 4 prior adapters'
accept-ignore signature + 2 `cli.ts` call sites, folded into Task 6 + the Architecture
C2 block; Task 5 gains the Wnew collision-proof-`.bak` test [+1] and the C2 threaded-
path MCP assertion [+1]; N1 dropped the non-existent `onPath` fallback; N2 corrected
file:line citations. Net new test cases over round 2: 2. No new task introduced; the W1
debounce and the dual-export hedge live in the existing plugin template + Task 8 smoke.)
