# Codex CLI Harness Adapter — Implementation Plan (#67)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD throughout: failing test first, then code, then green, then commit.

**Goal:** Ship the Codex CLI as the **second** qualifying harness behind the Phase-0 `HarnessAdapter` contract — auto-capture + auto-recall + MCP + stable session id — proving the abstraction survives a genuinely different harness, and introducing per-harness `external_id` namespacing (W1) the first time two harnesses coexist on one `memory.db`.

**Architecture:** A new `src/harness/adapters/codex.ts` composes the existing capabilities. Two capability generalizations are required because Codex differs from Claude on the two harness-coupled axes the Phase-0 plan deferred to here:

1. **MCP registration** — `registerMcpServer` is hardcoded to the `claude` binary. Generalize it to take a CLI binary + an `mcp add`/`mcp list`/`mcp remove` argv builder, so it drives both `claude mcp add agentbrainsystem -- node <cli> start` and `codex mcp add agentbrainsystem -- node <cli> start`. Claude behavior stays byte-identical (regression gate).
2. **Lifecycle install** — Codex hooks are NOT in `~/.claude/settings.json`; they live in `~/.codex/config.toml` under a `[hooks]` table (TOML, matcher-group arrays per PascalCase event). A new `CodexLifecycleInstaller` capability owns the TOML read/merge/write, idempotent + backup-first, mirroring `installHooks`'s safety contract but for TOML.

A third change is the **transcript parser**: Codex's rollout JSONL schema is fundamentally different from Claude's (different line `type`s, session id only in the header line **and the rollout FILENAME**, content blocks named `input_text`/`output_text` not `text`). A `codexParseTranscript` variant handles it; the JSONL ingest loop gains a per-format parser seam so Claude's path is untouched. Crucially the Codex sessionId is taken from the **filename UUID** (always present, on every resumed read), NOT from the in-file `session_meta` header — this lets Codex resume from a byte cursor exactly like Claude (no offset-0 re-read every turn), which is mandatory because `Stop` fires PER-TURN, not once per session (W4).

**W1 namespacing — ONE chokepoint, not per-site whack-a-mole (C-NEW-1, R4):** the session id namespace (`codex:<uuid>` for Codex, bare for Claude) is the store's join key, so it must reach the store identically on every path that mints, reads, or binds an external id — capture, recall, AND the skip/include consent flow. Rounds 1-3 namespaced at EACH consumer (`session-start.ts`, `user-prompt-submit.ts`, `scope.ts`, …); plan-critic then found a 7th and 8th un-namespaced site (the `abs project` CLI, the MCP `recall` tool). That is whack-a-mole: every new consumer of `payload.sessionId` is a fresh chance to forget the prefix.

**R4 chokepoint design — kill the class, not the instances.** Namespace `payload.sessionId` **ONCE, at the hook dispatch entry** (`dispatch.ts`, immediately after `parseHookPayload(raw)`, before `handler(payload)`). After that single mutation the *bare* id never propagates: `session-start.ts` / `user-prompt-submit.ts` / `scope.ts` / `renderNotice` / `readBinding` / `consumeFirstPromptFlag` / `getSessionByExternalId` ALL receive the already-namespaced `payload.sessionId` and use it verbatim — **zero per-site namespacing**. A future hook consumer is namespaced for free.

```typescript
// dispatch.ts — the single application point
const payload = parseHookPayload(raw);
if (payload.sessionId) {
  payload.sessionId = namespacedExternalId(harnessForPayload(payload), payload.sessionId);
}
return handler(payload);
```

The boundaries this chokepoint covers, and why each needs no per-site edit:

1. **Capture** — `Stop`/`SessionEnd` → `handleSessionEnd(payload)` → `ingestSingleSession(memory, transcriptPath)`. Capture derives its namespace from the **transcript PATH** inside ingest (`isCodexTranscript(absPath)` → `namespacedExternalId('codex', sessionIdFromPath)`), NOT from `payload.sessionId` — `handleSessionEnd` never reads `sessionId` (`session-end.ts:38`). So the chokepoint's mutation of `payload.sessionId` is inert for capture, and capture stays path-derived (Task 5). **The two derivations MUST produce the same string** — see the invariant below.
2. **Consent notice** (`session-start.ts` `renderNotice`) + **binding check** (`readBinding`) — both read `payload.sessionId`, which is already `codex:<uuid>` at the chokepoint. No edit to `session-start.ts`; the round-3 per-site `harnessForPayload` call there is REVERTED.
3. **First-prompt path** (`user-prompt-submit.ts`) — `renderNotice(payload.sessionId,…)`, the `skip`-guard `readBinding(store, payload.sessionId)`, and `consumeFirstPromptFlag(store, payload.sessionId)` (the `notice-shown:<id>` kv key) ALL read the already-namespaced `payload.sessionId`. No edit; round-3 per-site call REVERTED.
4. **Recall scope** (`scope.ts` `resolveRecallProject`) — when reached from the UserPromptSubmit hook, its `RecallScopeInput.sessionId` is the chokepoint-namespaced id (the hook passes `payload.sessionId`), so `readBinding`/`getSessionByExternalId` key the `codex:` row. No edit; round-3 per-site call REVERTED.

**The binding WRITER** (`set_session_project`, `mcp/server.ts:444-479`): the agent copies the namespaced id straight out of the notice (`session="codex:<uuid>"`), so `writeBinding(store, session, …)` writes `session-project:codex:<uuid>` — the SAME key ingest's `resolveBinding` reads. `set_session_project` treats `session` as **opaque** and applies NO prefix (single-application; verified it passes `session` straight through). Likewise the `abs project --session codex:<uuid>` CLI path writes the identical key with no re-derivation. CLI + MCP reconcile **without any per-path namespacing in `cli.ts` or `server.ts`** — both treat the id as opaque, the chokepoint already prefixed it.

**Single-application guarantee:** dispatch namespaces once; nothing downstream (handlers, CLI, MCP) re-namespaces. A guard test asserts no `codex:codex:` double-prefix can occur.

**The path-vs-payload INVARIANT (must hold, VERIFY before relying on it):** capture namespaces from the transcript path → `codex:<filename-uuid>`; recall/consent namespace from `payload.sessionId` → `codex:<payload session_id>`. These bind the SAME store session ONLY IF `filename-uuid === payload session_id`. The plan's ground truth establishes Codex `session_meta.payload.id === filename UUID` (line 81). The remaining link — `hook payload session_id === session_meta.id` — is the linchpin: Task 9 Step 4 VERIFIES it on a real Codex `Stop` (the captured row's external id `codex:<filename-uuid>` must equal the notice id `codex:<payload session_id>`). State this invariant explicitly; if it ever fails, capture and recall would target two different store rows and the chokepoint would silently misbind.

**Why round-3's per-site approach was abandoned:** it was correct but unbounded — every file that reads `payload.sessionId` had to remember to namespace, and two were missed (CLI, MCP recall). The chokepoint makes the bare id structurally unreachable past dispatch, so no future site can regress.

**Migration safety:** `namespacedExternalId('claude-code', x) === x` (bare), so Claude's notice text, binding key, and recall lookups stay byte-identical — zero Claude regression, zero migration of existing rows.

**Accepted inherent degradations (documented, NOT bugs — these are NOT parity-pillar breaks):**

1. **The MCP `recall` TOOL** (`server.ts:90-97`) has NO hook payload — no `harness`, no `transcriptPath`. It resolves `sessionId` via the Claude env adapter (`defaultRegistry().byId('claude-code')?.resolveSession({ env: process.env })`), which is `undefined` for Codex (Codex has no session-id env var), so for a Codex caller it falls through to **cwd-scoped** recall. This is acceptable: the auto-recall PARITY PILLAR is the **UserPromptSubmit HOOK** path, which IS namespaced via the chokepoint and hits the `codex:` row. The manual MCP `recall` tool degrading to cwd-scope for Codex is fine — cwd-scope is still correct project isolation, it just can't honor a session BINDING that no other session shares. The plan's recall claim is qualified to: **"hook-path auto-recall hits the namespaced row; the MCP `recall` tool is cwd-scoped for Codex."** No fix attempted (the tool has no payload to derive harness from; threading one is a separate item).
2. **`abs project` interactive WITHOUT `--session`** for Codex: Codex exposes no env session id, so a bare interactive `abs project --skip` (no `--session`) cannot resolve an id for a Codex session. Acceptable: the SessionStart notice instructs the agent to pass the namespaced `--session codex:<uuid>` (or use the `set_session_project` MCP tool). **Documented contract: `abs project` for Codex REQUIRES an explicit `--session codex:<uuid>` (no env autodetect).** A guard test asserts `abs project --skip --session codex:abc` writes `session-project:codex:abc` EXACTLY once (no double-prefix, no harness re-derivation in `cli.ts` — the CLI treats `--session` as opaque, mirroring the MCP tool).

**Tech Stack:** Node ≥ 22, TypeScript (ESM), Vitest, Biome, embedded SQLite via `better-sqlite3` (synchronous). TOML parsing/writing uses a hand-rolled minimal serializer scoped to the `[hooks]` table (no new dependency — see Task 3 rationale). Source-of-truth design doc: `docs/superpowers/specs/2026-05-22-multi-harness-support-design.md`. Builds on the Phase-0 adapter framework (`src/harness/`).

---

## Ground truth (Codex, verified on disk — `codex-cli 0.125.0`, native rust crate, `~/.codex/` on this machine)

These facts were probed directly (`codex --help`, `codex mcp add --help`, `codex features list`, `strings` on the native binary, a real rollout transcript, the live `config.toml`). They **correct the epic plan + design-doc assumptions**, which were research-derived and partly wrong for the installed version.

### Install layout
```
$ ls -la ~/.codex/
-rw-------  config.toml          # TOML config (NOT settings.json)
drwxr-xr-x  sessions/            # rollout transcripts, date-bucketed
drwxr-xr-x  archived_sessions/   # same schema, archived
-rw-r--r--  session_index.jsonl
AGENTS.md                        # the AGENTS.md instruction wrapper
```
There is **no `~/.codex/settings.json`** and **no `~/.codex/hooks.json` on this machine** (the binary references a `./hooks.json` path internally, but the user-facing surface is the `[hooks]` table in `config.toml`).

### MCP registration (real CLI contract)
```
$ codex mcp --help
Usage: codex mcp [OPTIONS] <COMMAND>
Commands: list  get  add  remove  login  logout

$ codex mcp add --help
Usage: codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)
  --env <KEY=VALUE>   Environment variables (stdio servers)
```
So the Codex registration argv is **structurally identical** to Claude's:
```
codex mcp add agentbrainsystem -- node <cliPath> start
codex mcp list           # lists registered servers (used for idempotency check)
codex mcp remove agentbrainsystem
```
Registered servers persist in `config.toml` under `[mcp_servers.<name>]` (the `[mcp_servers.*]` table family). We do NOT write that table ourselves — `codex mcp add` owns it; we only invoke the CLI (no shell ⇒ no injection, via the injected `run`).

### Lifecycle hooks — the big correction
- `codex features list` shows **`codex_hooks   stable   true`** — the hooks subsystem is shipped and on by default.
- There is **NO `codex hooks` CLI subcommand** (`codex --help` lists no `hooks` command). Hooks are **declared in `config.toml`, not via a CLI**.
- The native binary's `HookEventName` enum (confirmed by `strings` on the installed `codex-darwin-arm64` native binary `0.125.0` — the embedded JSON schema `"const"` list AND the concatenated enum string `PreToolUsePermissionRequestPostToolUseSessionStartUserPromptSubmitStop`) is **exactly these 6 events, PascalCase**:
  ```rust
  pub enum HookEventName {
      PreToolUse, PermissionRequest, PostToolUse,
      SessionStart, UserPromptSubmit, Stop,
  }
  ```
  **W2 correction:** earlier drafts listed `PreCompact, PostCompact, SubagentStart, SubagentStop` from a research-derived/newer source — those are **NOT in the installed `0.125.0` binary** and are dropped (verified absent: every `"const":` event in the embedded schema is one of the 6 above). **There is NO `SessionEnd`.** The session-finished moment is **`Stop`** (Claude's `SessionEnd` has no Codex equivalent; `Stop` is the closest "the agent finished a turn" signal — the design doc's table assigns it `CapturePoint = Stop`). **Caveat — `Stop` fires PER TURN, not once per session** (it is "the agent finished THIS turn"). This is the W4 hazard: see Task 5.
- A registered hook's identity key (from `hooks/list`, Context7 app-server README) is
  `"/Users/me/.codex/config.toml:pre_tool_use:0:0"` — i.e. `<sourcePath>:<snake_case_event>:<group_index>:<hook_index>`. The on-disk event keys are **snake_case** (`pre_tool_use`), the protocol enum is PascalCase. Hook entry fields: `eventName`, `handlerType: "command"`, `command`, `timeoutSec`, `matcher`, `source`, `enabled`.
- Each event is an **array of matcher groups**, each group `{ matcher, hooks: [{ type/handler, command, timeout }] }` — the **same shape as Claude's `hooks.<Event>[]`** in settings.json, just expressed as TOML under `config.toml`.

### Hook stdin payload
The hook handler is spawned with the hook JSON on **stdin** (same model as Claude). The payload carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` — the exact snake_case fields `parseHookPayload` (`src/hooks/payload.ts:54-61`) already reads. **No code change to `parseHookPayload` is needed for Codex.** Codex exposes **no session-id env var** (there is no `CODEX_*` equivalent of `CLAUDE_CODE_SESSION_ID`), so the Codex resolver is **payload-only** (no env-var fallback).

### Transcript schema — REAL sample (`~/.codex/sessions/2026/05/14/rollout-…-019e2658-c8b0-….jsonl`)
The filename embeds the session UUID: `rollout-<ISO-ts>-<UUID>.jsonl`, and that UUID equals `session_meta.payload.id`.

> **Version reconciliation (W2):** the canonical version for this plan is the **installed CLI: `codex --version` → `0.125.0`** (also the value the Task 1 test stubs). The `cli_version: 0.130.0-alpha.5` below is genuine captured data inside one real Codex Desktop transcript header (a different client wrote that rollout) — it is left verbatim as real fixture material, NOT a contradiction of the installed CLI. All event-surface and trust-gate facts in this section were probed against the installed `0.125.0` native binary.

Per-line top-level `type` values observed (one file): `session_meta` (header), `response_item`, `event_msg`, `turn_context`, `compacted`.

Representative lines (real, trimmed):
```json
{"timestamp":"2026-05-14T11:57:30.835Z","type":"session_meta","payload":{
  "id":"019e2658-c8b0-7230-9b59-c3646fbf0c7b","cwd":"/Users/.../PGIntegra",
  "originator":"Codex Desktop","cli_version":"0.130.0-alpha.5","source":"vscode"}}

{"timestamp":"…","type":"response_item","payload":{"type":"message","role":"user",
  "content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/…"}]}}

{"timestamp":"…","type":"response_item","payload":{"type":"message","role":"assistant",
  "content":[{"type":"output_text","text":"Vou localizar o comando…"}],"phase":"commentary"}}

{"timestamp":"…","type":"response_item","payload":{"type":"function_call",
  "name":"exec_command","arguments":"{\"cmd\":\"pwd && ls\",\"workdir\":\"/Users/…\"}",
  "call_id":"call_ZEZx…"}}

{"timestamp":"…","type":"event_msg","payload":{"type":"user_message",
  "message":"Inicie o serviço local do PGIntegra Cloud\n","images":[]}}

{"timestamp":"…","type":"event_msg","payload":{"type":"agent_message",
  "message":"Vou localizar…","phase":"commentary"}}
```

### Does Claude's `parseLine` work on Codex lines? **NO — a variant is mandatory.** Concretely:
| Claude `parseLine` assumption | Codex reality | Consequence |
|---|---|---|
| top-level `type` is `'user'`/`'assistant'` | `type` is `response_item`/`event_msg`/`session_meta`/… | every Codex line is rejected at `parseLine`'s `type !== 'user' && type !== 'assistant'` guard |
| `obj.sessionId` on **every** line | session id appears **only** in the `session_meta` line (and the filename) | `parseLine` returns null (`!sessionId`) for all conversation lines |
| `obj.message.{role,content}` | text lives in `payload.content[].text` (response_item) or `payload.message` string (event_msg) | wrong path |
| content block `type === 'text'` | Codex uses `input_text` / `output_text` | `extractText` extracts nothing |
| tool calls are `tool_use` blocks with `name`+`input.file_path` | tool calls are separate `response_item` lines `payload.type === 'function_call'`, `name` like `exec_command`/`apply_patch`, args as a **JSON string** in `payload.arguments` | no Edit/Write `tool_use` block exists; anchoring needs a Codex-specific extraction (deferred — see Task 5 scope note) |
| `obj.cwd` per line | `cwd` only in `session_meta.payload.cwd` | project derivation needs the header |

**Design consequence (revised for W4):** the sessionId comes from the **filename UUID** (`sessionIdFromPath`) — it is on EVERY path, present whether or not the read includes the `session_meta` header. This is what makes byte-cursor streaming possible: a resumed read that starts mid-file (past the header) still knows its sessionId. The `cwd` lives ONLY in the `session_meta` header, so the parser captures it when the header is in the read AND the ingest layer **caches it in `kv_meta`** (keyed by transcript path) so a later header-less resume still derives the project. Prose is extracted primarily from **`response_item.message`** lines (the canonical conversation record); the `event_msg` mirror (`user_message`/`agent_message`) is **de-duped by normalized text** (identical strings — confirmed in the sample) so a twinned turn is captured ONCE, but an `event_msg`-only turn (no `response_item` twin) is still captured rather than dropped (W-NEW-4 — proven by the multi-turn fixture).

> **W4 — `Stop` fires PER TURN.** If ingest re-parsed the whole file from offset 0 on every `Stop`, and `indexer.write` does NOT dedup (verified: `createObservation` is a plain `INSERT` with no UNIQUE/`ON CONFLICT` — `memory-store.ts:326`), every prior turn would be re-inserted each turn → a **duplicate-observation explosion** linear in turns². The fix is to stream from the persisted byte cursor exactly like Claude (resume, never re-read prior turns). Because the sessionId is from the FILENAME (not the header), a `start > 0` slice is safe — it never needs the header for the id. The header-only `cwd` is recovered from the kv_meta cache. **There is no offset-0 mandate.**

### Trust gate (W3 — real, confirmed in the binary)
The installed `0.125.0` binary contains the literal strings **`"skipping managed hooks from "`** and **`" is marked as untrusted in "`** (confirmed via `strings`). Codex **silently SKIPS `config.toml`-managed hooks for projects that are not trusted** — `[projects."<cwd>"] trust_level` must be `"trusted"` (the on-disk live `config.toml` shows `[projects.*]` tables carrying `trust_level`). Consequence: `abs install-hooks --harness codex` can wire a perfectly valid `[hooks]` block that **never fires** in an untrusted project — a silent no-op that looks like an `abs` bug but is Codex policy. Task 3 / Task 9 must surface this (detect trust + explicit success-line wording), not bury it in a footnote.

### W1 collision risk (real, now reachable)
Both harnesses use UUID session ids. Claude's `sessionId` and Codex's `session_meta.id` are both v7-style UUIDs from independent generators. A collision is astronomically unlikely **by value**, but the store keys sessions by `external_id` with a `UNIQUE`-style lookup (`getSessionByExternalId` → `SELECT … WHERE external_id = ?`), and the **`session-project:<externalId>` binding** is keyed the same way. The design doc (line 117) mandates **namespacing the session id by source**. We do it now (Task 6), the first time two harnesses share one DB, and make it **migration-safe** so every existing Claude `external_id` still resolves.

---

## File map

- **Modify** `src/cli/setup.ts` — generalize `registerMcpServer`/`unregisterMcpServer` to a CLI binary + argv builder (Task 1).
- **Modify** `src/harness/capabilities/mcp-registrar.ts` — `cliMcpRegistrar` accepts the binary (Task 2).
- **Create** `src/harness/capabilities/codex-lifecycle-installer.ts` — TOML `[hooks]` installer, proven-idempotent + trust-aware (Task 3); real-config fixture `src/harness/capabilities/__fixtures__/codex/config.toml`; `@iarna/toml@^2.2.5` added to **devDependencies** only (test import only, no runtime dep).
- **Create** `src/ingest/codex-jsonl.ts` — Codex transcript parser, filename-UUID sessionId + returns observed cwd (Task 4) + tool-anchor follow-on (out of scope).
- **Create** `src/ingest/namespacing.ts` — TRUE LEAF (W-R3-1): `isCodexTranscript` + `harnessForPayload` + `namespacedExternalId`, depending on NOTHING from `ingest.ts`/hooks (Task 6, W1/C-NEW-1).
- **Modify** `src/ingest/ingest.ts` — per-format seam: cursor-streamed Codex branch, kv_meta cwd cache, path-derived `codex:` namespace (Task 5, W4/C1). **IMPORTS** `isCodexTranscript` + `namespacedExternalId` from `namespacing.ts` (one direction — no cycle). **No `harnessId` param threaded** — the namespace is derived from `isCodexTranscript(absPath)`, because the real `dispatchHook('session-end')` path carries no harness.
- **Modify** `src/ingest/index.ts` — re-export `namespacedExternalId`, `harnessForPayload`, `isCodexTranscript` from `namespacing.ts` so the dispatch chokepoint imports them from the ingest barrel (Task 6).
- **Modify** `src/hooks/dispatch.ts` — **THE CHOKEPOINT (Task 6b, R4):** namespace `payload.sessionId` ONCE after `parseHookPayload`, before any handler. This is the ONLY namespacing site for the payload-derived id. (Test `src/hooks/dispatch.test.ts`.)
- **`src/hooks/session-start.ts`, `src/hooks/user-prompt-submit.ts`, `src/recall/scope.ts`, `src/mcp/server.ts`** — **NOT modified for namespacing.** They read `payload.sessionId`/`session`/`input.sessionId` as an opaque already-namespaced string (the chokepoint did the work). The round-3 revision's per-site `harnessForPayload` calls in these files are REVERTED to keep them clean. `mcp/server.ts` is verify-only: it treats `session` as opaque (no double-prefix) — a guard test confirms.
- **Create** `src/harness/adapters/codex.ts` — the adapter, `mcpBinary: 'codex'` (Task 7).
- **Modify** `src/harness/index.ts` — register Codex; **`src/harness/types.ts`** — add `mcpBinary?`; **`src/harness/adapters/claude-code.ts`** — set `mcpBinary: 'claude'`; **`src/cli/cli.ts`** — rewrite `cmdUninstall` to be `--harness`-aware + reorder `cmdSetup` MCP-before-hooks (Task 8, C2/W1-warn).
- Tests alongside each (`*.test.ts`), plus real fixtures under `src/ingest/__fixtures__/codex/` and `src/harness/capabilities/__fixtures__/codex/`.

The core (`src/store`, `src/recall`, `src/embedding`, `src/optimize`) stays harness-agnostic; nothing there imports `src/harness`. The W1 helper lives in `src/ingest` (allowed). NOTE: `src/store/memory-store.ts` is NOT modified (an earlier draft listed it for namespacing — the namespace is composed at the ingest boundary, the store stays untouched).

---

## Task 1: Generalize `registerMcpServer` to any CLI binary

**Files:** Modify `src/cli/setup.ts` · Test `src/cli/setup.test.ts`

Keep Claude behavior byte-identical: the existing exported `registerMcpServer(cliPath, run)` must keep working (it's called by `cliMcpRegistrar`). We add a binary parameter with a `claude` default and an argv-builder seam.

- [ ] **Step 1: Write the failing test** — add to `src/cli/setup.test.ts`:

```typescript
describe('registerMcpServer — generalized to any CLI binary', () => {
  it('drives a codex binary: probes "codex --version", lists, then "codex mcp add … -- node <cli> start"', async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args.includes('--version')) return { code: 0, stdout: 'codex-cli 0.125.0', stderr: '' };
      if (args.includes('list')) return { code: 0, stdout: '', stderr: '' }; // not registered yet
      return { code: 0, stdout: '', stderr: '' };
    };
    const res = await registerMcpServer('/abs/cli.js', run, { binary: 'codex' });
    expect(res.status).toBe('registered');
    expect(calls[0]).toEqual(['codex', '--version']);
    expect(calls.at(-1)).toEqual(['codex', 'mcp', 'add', 'agentbrainsystem', '--', 'node', '/abs/cli.js', 'start']);
  });

  it('defaults to the claude binary when no options are passed (regression)', async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args.includes('--version')) return { code: 0, stdout: 'claude', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    await registerMcpServer('/abs/cli.js', run);
    expect(calls[0]).toEqual(['claude', '--version']);
    expect(calls.at(-1)).toEqual(['claude', 'mcp', 'add', 'agentbrainsystem', '--', 'node', '/abs/cli.js', 'start']);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/cli/setup.test.ts` → FAIL (`registerMcpServer` takes 2 args; no `binary` option).

- [ ] **Step 3: Generalize `setup.ts`.** Introduce an options object and binary-aware argv builders, keeping the old single-binary helpers as thin wrappers:

```typescript
export interface McpRegisterOptions {
  /** CLI binary that owns `mcp add/list/remove` (defaults to 'claude'). */
  binary?: string;
}

/** `<binary> mcp add agentbrainsystem -- node <cli> start`. */
export function buildMcpAddArgs(cliPath: string): string[] {
  return ['mcp', 'add', MCP_SERVER_NAME, '--', 'node', cliPath, 'start'];
}
export function buildMcpListArgs(): string[] { return ['mcp', 'list']; }
export function buildMcpRemoveArgs(): string[] { return ['mcp', 'remove', MCP_SERVER_NAME]; }

/** Manual fallback command shown when the binary is absent. */
export function manualMcpCommand(cliPath: string, binary = 'claude'): string {
  return `${binary} mcp add ${MCP_SERVER_NAME} -- node ${cliPath} start`;
}
export function manualMcpRemoveCommand(binary = 'claude'): string {
  return `${binary} mcp remove ${MCP_SERVER_NAME}`;
}
```

Then thread `binary` through `registerMcpServer`/`unregisterMcpServer`:

```typescript
export async function registerMcpServer(
  cliPath: string,
  run: RunFn,
  options: McpRegisterOptions = {},
): Promise<RegisterResult> {
  const binary = options.binary ?? 'claude';
  const manualCommand = manualMcpCommand(cliPath, binary);

  let probe: RunResult;
  try {
    probe = await run(binary, ['--version']);
  } catch {
    return { status: 'no-claude', manualCommand };
  }
  if (probe.code !== 0) return { status: 'no-claude', manualCommand };

  try {
    const list = await run(binary, buildMcpListArgs());
    if (list.code === 0 && list.stdout.includes(MCP_SERVER_NAME)) return { status: 'already' };
  } catch { /* fall through and attempt add */ }

  const added = await run(binary, buildMcpAddArgs(cliPath));
  if (added.code === 0) return { status: 'registered' };
  const message = (added.stderr || added.stdout).trim() || `exit ${added.code}`;
  return { status: 'error', message, manualCommand };
}

export async function unregisterMcpServer(
  run: RunFn,
  options: McpRegisterOptions = {},
): Promise<UnregisterResult> {
  const binary = options.binary ?? 'claude';
  const manualCommand = manualMcpRemoveCommand(binary);
  let probe: RunResult;
  try { probe = await run(binary, ['--version']); }
  catch { return { status: 'no-claude', manualCommand }; }
  if (probe.code !== 0) return { status: 'no-claude', manualCommand };
  try {
    const list = await run(binary, buildMcpListArgs());
    if (list.code === 0 && !list.stdout.includes(MCP_SERVER_NAME)) return { status: 'not-registered' };
  } catch { /* fall through */ }
  const removed = await run(binary, buildMcpRemoveArgs());
  if (removed.code === 0) return { status: 'removed' };
  const message = (removed.stderr || removed.stdout).trim() || `exit ${removed.code}`;
  return { status: 'error', message, manualCommand };
}
```

Keep the old names `buildClaudeMcpAddArgs`/`buildClaudeMcpRemoveArgs` as re-export aliases of `buildMcpAddArgs`/`buildMcpRemoveArgs` if any caller/test still imports them (search: `git grep -n "buildClaudeMcp" src`); otherwise rename their references in the same commit. The `status: 'no-claude'` literal name is retained verbatim (renaming it is out of scope — `cliMcpRegistrar` already maps it to `unavailable`).

- [ ] **Step 4: Run** `npx vitest run src/cli/setup.test.ts` → PASS (new + existing).

- [ ] **Step 5: Commit**
```bash
git add src/cli/setup.ts src/cli/setup.test.ts
git commit -m "feat(setup): generalize MCP register/unregister to any CLI binary (#67)"
```

---

## Task 2: `cliMcpRegistrar` accepts the binary

**Files:** Modify `src/harness/capabilities/mcp-registrar.ts` · Test `src/harness/capabilities/mcp-registrar.test.ts`

- [ ] **Step 1: Write the failing test** — add:

```typescript
it('passes the configured binary through to registerMcpServer (codex)', async () => {
  const seen: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    seen.push(cmd);
    if (args.includes('--version')) return { code: 0, stdout: 'codex', stderr: '' };
    if (args.includes('list')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const registrar = cliMcpRegistrar({ binary: 'codex' });
  expect((await registrar.register('/cli.js', run)).status).toBe('registered');
  expect(seen.every((c) => c === 'codex')).toBe(true);
});
```

- [ ] **Step 2: Run** `npx vitest run src/harness/capabilities/mcp-registrar.test.ts` → FAIL (`cliMcpRegistrar` takes no args).

- [ ] **Step 3: Add the option:**

```typescript
export interface CliMcpRegistrarOptions {
  /** CLI binary that owns `mcp add/list/remove` (defaults to 'claude'). */
  binary?: string;
}

export function cliMcpRegistrar(options: CliMcpRegistrarOptions = {}): McpRegistrar {
  return {
    register: async (cliPath, run) => {
      const result = await registerMcpServer(cliPath, run, { binary: options.binary });
      if (result.status === 'no-claude') {
        return { status: 'unavailable', manualCommand: result.manualCommand };
      }
      return result;
    },
  };
}
```

The Claude adapter's `cliMcpRegistrar()` call (no args) keeps the `'claude'` default — regression-safe.

- [ ] **Step 4: Run** `npx vitest run src/harness/capabilities/mcp-registrar.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/harness/capabilities/mcp-registrar.ts src/harness/capabilities/mcp-registrar.test.ts
git commit -m "feat(harness): cliMcpRegistrar takes a configurable CLI binary (#67)"
```

---

## Task 3: `CodexLifecycleInstaller` — TOML `[hooks]` installer

**Files:** Create `src/harness/capabilities/codex-lifecycle-installer.ts` · Test `src/harness/capabilities/codex-lifecycle-installer.test.ts`

Codex hooks live in `~/.codex/config.toml` under a `[hooks]` table, as matcher-group arrays per PascalCase event — same logical shape as Claude's settings.json, different file + format. We own ONLY the `[hooks]` table; every other TOML key/table is preserved verbatim.

**Why a hand-rolled minimal TOML writer (no new dependency):** the project ships zero TOML deps and the repo policy is "git only the essentials". A full TOML round-trip lib risks reformatting the user's entire `config.toml` (the live file has dozens of `[projects.*]`/`[plugins.*]` tables + a multiline `notify` array). Safer: **read the raw text, splice only the `[hooks]` block** (parse just enough to find/replace our managed block, delimited by sentinel comments), append if absent, and never touch the rest. This matches the installer's "never clobber unrelated keys" contract (ADR-0004) better than a reformat-everything round-trip.

**Managed-block strategy:** wrap our hooks in sentinel comments so install is idempotent and uninstall is a clean excision:
```toml
# >>> agentbrainsystem hooks (managed — do not edit) >>>
[[hooks.SessionStart]]
matcher = ""
[[hooks.SessionStart.hooks]]
type = "command"
command = "abs hook session-start"
timeout = 10
# … Stop, UserPromptSubmit, PreToolUse blocks …
# <<< agentbrainsystem hooks (managed) <<<
```

**Event map (Codex, from ground truth):**
| Canonical moment | Codex event | matcher | `abs hook` arg |
|---|---|---|---|
| capture | `Stop` | `""` | `session-end` (reuse the existing capture handler; the arg name is internal) |
| recall | `SessionStart` | `""` | `session-start` |
| recall | `UserPromptSubmit` | `""` | `user-prompt-submit` |
| guard | `PreToolUse` | `"Edit\|Write"` (Codex apply_patch still surfaces as a tool name; matcher is best-effort, see note) | `pre-tool-use` |

> Note on `Stop` → `session-end` arg: the existing capture handler is registered under the CLI subcommand `session-end` and ingests `payload.transcriptPath` (`src/hooks/session-end.ts:38-47`). The Codex `Stop` payload carries `transcript_path`, so the SAME handler works unchanged. We map the canonical *moment* to the existing arg; we do not rename the handler.
>
> Note on `PreToolUse` matcher: Codex tool names differ (`exec_command`, `apply_patch`). The guard only fires for code-duplication risk; if `Edit|Write` never matches a Codex tool, the guard simply never fires (fail-safe, no error). Set matcher to `""` if a follow-up confirms Codex emits no Edit/Write-named tools — but ship `""` is acceptable here since the guard self-bounds and fails open. **Decision: ship matcher `""` for PreToolUse on Codex** (fires on every tool, the handler itself decides relevance), avoiding a silent never-fire.

**C3 — proven idempotency + real-config fixture + valid-TOML guarantee.** Hand-rolling a TOML splice is only safe if we PROVE three things with tests, not prose:
> 1. **One normalization function.** ALL newline normalization lives in a single `normalize(toml)` helper used by BOTH `stripManaged` and `install` (no split logic that could drift). The early `next === current` no-op compares fully-normalized strings.
> 2. **Real-config fixture.** Commit `src/harness/capabilities/__fixtures__/codex/config.toml` — a COPY of the live `~/.codex/config.toml` with secrets stubbed (API keys / tokens / OAuth → `"REDACTED"`; keep every `[projects.*]`, `[mcp_servers.*]`, `[plugins.*]` table, the multiline `notify` array, and `trust_level` keys structurally intact). Mirrors Task 4's real-fixture standard.
> 3. **Byte-identical across 3 runs + still valid TOML.** A test runs `install()` 3× over the fixture and asserts the on-disk bytes are identical after run 1, 2, and 3. After install it re-parses the result as TOML to assert validity — using a **dev-only** `@iarna/toml` parse in the test (NOT a runtime dep; add to `devDependencies` only, imported solely from the test). The runtime code never imports it.
>
> Backup-first + atomic temp+rename, exactly like the Claude installer (ADR-0004).

**W3 — trust detection.** `codexLifecycleInstaller` accepts the parsed/raw config text and exposes whether the install target is in a trusted project. The installer's `install()` result carries a `trustWarning?: string` (or the adapter/CLI computes it) so `abs install-hooks --harness codex` can either WARN (untrusted cwd) or emit an explicit success line: `"hooks wired — they fire only in TRUSTED Codex projects"`. A best-effort check scans the raw TOML for a `[projects."<cwd>"]` block whose `trust_level = "trusted"`; absent/other ⇒ warn. This is a real output behavior with an acceptance assertion (Task 9 Step 2), not a footnote.

- [ ] **Step 1: Write the failing test:**

```typescript
// src/harness/capabilities/codex-lifecycle-installer.test.ts
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexLifecycleInstaller } from './codex-lifecycle-installer.js';

let dir: string;
let configPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-codex-hooks-'));
  configPath = join(dir, 'config.toml');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('codexLifecycleInstaller', () => {
  it('writes the four managed hook blocks and reports three moments', async () => {
    writeFileSync(configPath, 'model = "gpt-5.5"\n[projects."/x"]\ntrust_level = "trusted"\n');
    const installer = codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' });
    const report = await installer.install();
    expect(report.wired.slice().sort()).toEqual(['capture', 'guard', 'recall']);
    const toml = readFileSync(configPath, 'utf8');
    expect(toml).toContain('[[hooks.Stop]]');
    expect(toml).toContain('[[hooks.SessionStart]]');
    expect(toml).toContain('[[hooks.UserPromptSubmit]]');
    expect(toml).toContain('[[hooks.PreToolUse]]');
    expect(toml).toContain('abs hook session-end');     // Stop → capture handler
    expect(toml).toContain('abs hook session-start');
    expect(toml).toContain('abs hook user-prompt-submit');
    expect(toml).toContain('abs hook pre-tool-use');
    // Unrelated tables preserved verbatim.
    expect(toml).toContain('model = "gpt-5.5"');
    expect(toml).toContain('[projects."/x"]');
  });

  it('is idempotent — a second install neither duplicates nor errors', async () => {
    writeFileSync(configPath, '');
    const installer = codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' });
    await installer.install();
    const once = readFileSync(configPath, 'utf8');
    await installer.install();
    expect(readFileSync(configPath, 'utf8')).toBe(once);
  });

  it('creates a timestamped .bak before mutating an existing config', async () => {
    writeFileSync(configPath, 'model = "gpt-5.5"\n');
    await codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' }).install();
    const baks = require('node:fs').readdirSync(dir).filter((f: string) => f.endsWith('.bak'));
    expect(baks.length).toBe(1);
  });

  it('uninstall removes exactly the managed block, leaving the rest untouched', async () => {
    writeFileSync(configPath, 'model = "gpt-5.5"\n');
    const installer = codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' });
    await installer.install();
    const report = await installer.uninstall();
    expect(report.removed.slice().sort()).toEqual(['capture', 'guard', 'recall']);
    const toml = readFileSync(configPath, 'utf8');
    expect(toml).not.toContain('[[hooks.');
    expect(toml).not.toContain('agentbrainsystem hooks');
    expect(toml).toContain('model = "gpt-5.5"');
  });

  it('refuses to write through a symlinked config (safety)', async () => {
    const real = join(dir, 'real.toml');
    writeFileSync(real, 'model = "x"\n');
    require('node:fs').symlinkSync(real, configPath);
    await expect(codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' }).install())
      .rejects.toThrow(/symlink/);
  });

  // --- C3: real-config fixture, byte-identical 3 runs, still-valid TOML ---
  it('is byte-identical across 3 consecutive installs over the REAL-config fixture', async () => {
    const fixture = readFileSync(
      join(__dirname, '__fixtures__/codex/config.toml'), 'utf8'); // committed real config, secrets stubbed
    writeFileSync(configPath, fixture);
    const installer = codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' });
    await installer.install();
    const r1 = readFileSync(configPath);
    await installer.install();
    const r2 = readFileSync(configPath);
    await installer.install();
    const r3 = readFileSync(configPath);
    expect(r1.equals(r2)).toBe(true);
    expect(r2.equals(r3)).toBe(true);
    // Every unrelated table from the real fixture survives verbatim.
    const out = r3.toString('utf8');
    expect(out).toContain('[mcp_servers'); // real config has MCP servers
    expect(out).toContain('trust_level');
  });

  it('produces output that still parses as valid TOML (dev-only @iarna/toml in the test)', async () => {
    const { parse } = await import('@iarna/toml'); // devDependency ONLY — never a runtime import
    const fixture = readFileSync(join(__dirname, '__fixtures__/codex/config.toml'), 'utf8');
    writeFileSync(configPath, fixture);
    await codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' }).install();
    const out = readFileSync(configPath, 'utf8');
    expect(() => parse(out)).not.toThrow();
    const parsed = parse(out) as Record<string, unknown>;
    expect(parsed.hooks).toBeDefined(); // our [hooks] table round-trips
  });

  // --- W3: trust detection surfaces in the install report ---
  it('flags an untrusted target cwd via the install report', async () => {
    writeFileSync(configPath, 'model = "x"\n[projects."/work/foo"]\ntrust_level = "untrusted"\n');
    const report = await codexLifecycleInstaller({
      configPath, baseCommand: 'abs hook', projectCwd: '/work/foo',
    }).install();
    expect(report.trustWarning).toMatch(/trust/i);
  });

  it('omits the trust warning when the target cwd is trusted', async () => {
    writeFileSync(configPath, 'model = "x"\n[projects."/work/foo"]\ntrust_level = "trusted"\n');
    const report = await codexLifecycleInstaller({
      configPath, baseCommand: 'abs hook', projectCwd: '/work/foo',
    }).install();
    expect(report.trustWarning).toBeUndefined();
  });

  // --- W-NEW-2: trust check runs against a REAL cwd row present in the real-config fixture ---
  it('resolves trust against the real-config fixture using a path that actually exists in it', async () => {
    const fixture = readFileSync(join(__dirname, '__fixtures__/codex/config.toml'), 'utf8');
    writeFileSync(configPath, fixture);
    // Pull the FIRST real [projects."<path>"] row + its trust_level straight from the fixture,
    // so this asserts against realistic on-disk data, not a synthetic /work/foo.
    const m = fixture.match(/\[projects\.("[^"]+")\]\s*\n(?:[^\[]*?)trust_level\s*=\s*"(\w+)"/);
    expect(m).not.toBeNull();                                  // fixture must carry at least one real project row
    const realCwd = JSON.parse(m![1]) as string;              // the un-escaped absolute path
    const realTrust = m![2];
    const report = await codexLifecycleInstaller({
      configPath, baseCommand: 'abs hook', projectCwd: realCwd,
    }).install();
    if (realTrust === 'trusted') expect(report.trustWarning).toBeUndefined();
    else expect(report.trustWarning).toMatch(/trust/i);
  });
});
```

- [ ] **Step 1b: Create the real-config fixture (C3 + W-NEW-2).** Copy the live `~/.codex/config.toml` to `src/harness/capabilities/__fixtures__/codex/config.toml`, then stub secrets: replace any `api_key`/`token`/OAuth/credential values with `"REDACTED"`. Keep ALL `[projects.*]`, `[mcp_servers.*]`, `[plugins.*]` tables, the multiline `notify` array, and `trust_level` keys structurally intact (these are exactly the shapes the splice must not disturb). **W-NEW-2:** the live config already carries a `[projects."<this-repo-abs-path>"]` table — KEEP that exact path + its real `trust_level` so the trust-warning assertion below runs against REALISTIC data (a path that genuinely exists in the fixture), not only the synthetic `/work/foo`. If the live config lacks a row for this repo, ADD one with the repo's absolute path and `trust_level = "trusted"`, and document the path in the fixture as the realistic trust target. Add `@iarna/toml` to **`devDependencies` only**, **version-pinned**: `npm i -D @iarna/toml@^2.2.5` — dev-only, test import only, NO runtime dependency. It is imported solely from the test (`await import('@iarna/toml')`), never from runtime code.

- [ ] **Step 2: Run** `npx vitest run src/harness/capabilities/codex-lifecycle-installer.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the capability.** Mirror `installer.ts`'s safety primitives (symlink refusal, backup-first, atomic temp+rename) but operate on the raw TOML text + a managed sentinel block. **All newline normalization lives in ONE `normalize()` helper** used by both `stripManaged` and `install` (C3 — no split logic). The installer takes an optional `projectCwd` and returns a `trustWarning` (W3). Pseudostructure:

```typescript
// src/harness/capabilities/codex-lifecycle-installer.ts
import { copyFileSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { InstallReport, LifecycleMoment, UninstallReport } from '../types.js';

const BEGIN = '# >>> agentbrainsystem hooks (managed — do not edit) >>>';
const END = '# <<< agentbrainsystem hooks (managed) <<<';

/** Codex native event → canonical moment + the `abs hook` arg the existing handler uses. */
interface CodexHookSpec { event: string; moment: LifecycleMoment; arg: string; matcher: string; timeout: number; }
const CODEX_HOOKS: readonly CodexHookSpec[] = [
  { event: 'Stop',             moment: 'capture', arg: 'session-end',        matcher: '', timeout: 30 },
  { event: 'SessionStart',     moment: 'recall',  arg: 'session-start',      matcher: '', timeout: 10 },
  { event: 'UserPromptSubmit', moment: 'recall',  arg: 'user-prompt-submit', matcher: '', timeout: 10 },
  { event: 'PreToolUse',       moment: 'guard',   arg: 'pre-tool-use',       matcher: '', timeout: 5  },
];

export interface CodexInstallerOptions {
  configPath?: string;
  baseCommand?: string;
  /** Trusted-project check target (W3). When set, install() reports trustWarning if untrusted. */
  projectCwd?: string;
}
/** InstallReport gains an optional W3 trust warning (extend the shared type or widen here). */
export interface LifecycleInstaller {
  install(): Promise<InstallReport & { trustWarning?: string }>;
  uninstall(): Promise<UninstallReport>;
}

function defaultConfigPath(): string { return join(homedir(), '.codex', 'config.toml'); }

/** SINGLE source of newline normalization (C3) — both stripManaged and install use this. */
function normalize(toml: string): string {
  return toml.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * W3: best-effort trust check. Returns a warning string when the target cwd is NOT
 * a trusted Codex project (so wired hooks would silently never fire), else undefined.
 * Scans the raw TOML for `[projects."<cwd>"]` … `trust_level = "trusted"`.
 */
function trustWarningFor(toml: string, projectCwd: string | undefined): string | undefined {
  if (!projectCwd) return undefined;
  // Find the [projects."<cwd>"] table header, then its trust_level within that block.
  const header = `[projects.${JSON.stringify(projectCwd)}]`;
  const i = toml.indexOf(header);
  const block = i >= 0 ? toml.slice(i, toml.indexOf('\n[', i + 1) >= 0 ? toml.indexOf('\n[', i + 1) : undefined) : '';
  if (/trust_level\s*=\s*"trusted"/.test(block)) return undefined;
  return `Codex skips managed hooks in untrusted projects — set trust_level = "trusted" for ${projectCwd} or the hooks will never fire.`;
}

function assertNotSymlink(path: string): void {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error(`config.toml at ${path} is a symlink — refusing to write through it.`); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
function readText(path: string): string { try { return readFileSync(path, 'utf8'); } catch { return ''; } }
function backup(path: string): void {
  try { readFileSync(path); } catch { return; }
  copyFileSync(path, `${path}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
}
function atomicWrite(path: string, content: string): void {
  const dir = dirname(path); mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.abs-codex-tmp-${Date.now()}-${process.pid}`);
  try { writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 }); renameSync(tmp, path); }
  catch (e) { try { rmSync(tmp, { force: true }); } catch {} throw e; }
}

/** Strip an existing managed block (idempotency + uninstall). Normalizes via the SINGLE normalize(). */
function stripManaged(toml: string): string {
  const b = toml.indexOf(BEGIN);
  if (b < 0) return normalize(toml);
  const e = toml.indexOf(END, b);
  if (e < 0) return normalize(toml); // malformed — leave content as-is (just normalize), don't nuke
  const before = toml.slice(0, b);
  const after = toml.slice(e + END.length);
  return normalize(`${before}${after}`);
}

function renderBlock(baseCommand: string): string {
  const lines: string[] = [BEGIN];
  for (const h of CODEX_HOOKS) {
    lines.push(`[[hooks.${h.event}]]`, `matcher = ${JSON.stringify(h.matcher)}`);
    lines.push(`[[hooks.${h.event}.hooks]]`, 'type = "command"',
      `command = ${JSON.stringify(`${baseCommand} ${h.arg}`)}`, `timeout = ${h.timeout}`);
  }
  lines.push(END);
  return lines.join('\n');
}

const MOMENTS: LifecycleMoment[] = [...new Set(CODEX_HOOKS.map((h) => h.moment))];

export function codexLifecycleInstaller(options: CodexInstallerOptions = {}): LifecycleInstaller {
  const configPath = options.configPath ?? defaultConfigPath();
  const baseCommand = options.baseCommand ?? 'abs hook';
  return {
    install: async () => {
      assertNotSymlink(configPath);
      const raw = readText(configPath);
      const current = normalize(raw);              // normalize once, compare normalized (C3)
      const trustWarning = trustWarningFor(raw, options.projectCwd); // W3
      const stripped = stripManaged(raw);          // already normalized inside
      const block = renderBlock(baseCommand);
      const next = stripped.trim().length > 0 ? `${stripped.replace(/\n+$/, '\n')}\n${block}\n` : `${block}\n`;
      if (next === current) return { wired: MOMENTS, ...(trustWarning ? { trustWarning } : {}) };
      backup(configPath);
      atomicWrite(configPath, next);
      return { wired: MOMENTS, ...(trustWarning ? { trustWarning } : {}) };
    },
    uninstall: async () => {
      assertNotSymlink(configPath);
      const raw = readText(configPath);
      if (!raw.includes(BEGIN)) return { removed: [] };
      backup(configPath);
      atomicWrite(configPath, stripManaged(raw)); // stripManaged already normalizes
      return { removed: MOMENTS };
    },
  };
}
```

> Idempotency contract (C3, test-proven): `normalize()` is the SINGLE newline authority — both `stripManaged` and the `current`/`next` comparison run through it, so there is no normalization drift between strip and write. Install strips any prior managed block then re-appends a freshly rendered one; re-running with the same `baseCommand` reproduces BYTE-IDENTICAL text (the 3-run fixture test asserts `Buffer.equals`), so the early `next === current` return makes runs 2 and 3 true no-ops (no backup, no write). The `@iarna/toml` re-parse test proves the spliced result is still valid TOML.

- [ ] **Step 4: Run** `npx vitest run src/harness/capabilities/codex-lifecycle-installer.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/harness/capabilities/codex-lifecycle-installer.ts \
        src/harness/capabilities/codex-lifecycle-installer.test.ts \
        src/harness/capabilities/__fixtures__/codex/config.toml \
        package.json package-lock.json
git commit -m "feat(harness): Codex TOML [hooks] lifecycle installer — proven-idempotent, trust-aware (#67)"
```

---

## Task 4: Codex transcript parser (`codex-jsonl.ts`)

**Files:** Create `src/ingest/codex-jsonl.ts` · Test `src/ingest/codex-jsonl.test.ts` · Fixtures `src/ingest/__fixtures__/codex/*.jsonl`

The parser takes the transcript text plus the absolute path and an optional `cwdHint`. The **sessionId is derived from the filename UUID** (`sessionIdFromPath`) so it is known on every read, header or not (W4 — enables cursor streaming). The `session_meta` header, when present in the read, refines the `cwd`; otherwise the `cwdHint` (from the kv_meta cache, supplied by the ingest layer) provides it. Conversation prose is taken primarily from `response_item` `message` lines; `event_msg` twins are de-duped by normalized text (captured once), an `event_msg`-only turn is still captured (W-NEW-4), and machine lines (`turn_context`/`function_call`/`reasoning`) are skipped. Reuses `ParsedEntry` from `claude-jsonl.ts` (import — do not duplicate). Tool-anchor extraction from `function_call`/`apply_patch` lines is **out of scope for this task** (see scope note); `toolAnchors` is always `[]` for now, so Codex contributes prose-only observations (still a full capture/recall win; anchoring is a follow-on).

> **Returns `{ entries, cwd }`** — the parser also returns the `cwd` it observed in `session_meta` (or undefined), so the ingest layer can WRITE it to the kv_meta cache after a read that included the header. This is the seam that lets a later header-less resume recover the project.

- [ ] **Step 1: Create a real fixture.** Copy ~12 representative lines from a real rollout into `src/ingest/__fixtures__/codex/rollout-sample.jsonl` — at minimum: one `session_meta`, one `response_item`/`message`/`user` (with `input_text`), one `response_item`/`message`/`assistant` (with `output_text`), one `response_item`/`function_call`, one `event_msg`/`user_message`, one `event_msg`/`agent_message`, one `turn_context`. Strip any secrets (auth tokens, full base_instructions text — truncate to a short stub). Keep the structural shapes intact.

- [ ] **Step 1b: Create a MULTI-TURN fixture (W-NEW-4 — resolve the no-double-count claim with data, not prose).** Add `src/ingest/__fixtures__/codex/rollout-multiturn.jsonl` with ≥3 distinct user/assistant turns, where SOME turns have BOTH a `response_item/message` AND its `event_msg` (`user_message`/`agent_message`) twin (the common case), and AT LEAST ONE turn has ONLY an `event_msg` with NO `response_item/message` twin (the edge case where the chosen primary source would otherwise DROP a real turn). This fixture is the evidence for the capture-source decision below — copy real distinct turns from a genuine rollout, secrets stripped.

  > **Capture-source decision (W-NEW-4), resolved by the multi-turn fixture.** Primary source is `response_item/message` (the canonical conversation record). The `event_msg` twin is normally a duplicate of the same text → skipping it avoids double-counting. BUT a turn that has ONLY an `event_msg` (no `response_item/message` twin) would be silently dropped. So the rule is: **emit the `response_item/message` for a turn; fall back to capturing `event_msg` ONLY when that turn has no `response_item/message` twin.** De-dupe is by normalized turn text within the parse, so a twinned `event_msg` never double-counts. The multi-turn fixture asserts BOTH: (a) every twinned turn is captured exactly once (no double-count), AND (b) the event_msg-only turn is still captured (no drop). This replaces the prose-only "skipped to avoid double-counting" claim with a fixture-backed contract.

- [ ] **Step 2: Write the failing test:**

```typescript
// src/ingest/codex-jsonl.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexParseTranscript } from './codex-jsonl.js';

const fixture = readFileSync(join(__dirname, '__fixtures__/codex/rollout-sample.jsonl'), 'utf8');

const REAL_PATH = '/abs/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl';

describe('codexParseTranscript', () => {
  it('takes sessionId from the FILENAME and cwd from session_meta, applied to every entry', () => {
    const { entries, cwd } = codexParseTranscript(fixture, REAL_PATH);
    expect(entries.length).toBeGreaterThan(0);
    expect(cwd).toBe('/Users/.../PGIntegra'); // returned for the kv_meta cache
    for (const e of entries) {
      expect(e.sessionId).toBe('019e2658-c8b0-7230-9b59-c3646fbf0c7b'); // FROM FILENAME (W4)
      expect(e.cwd).toBe('/Users/.../PGIntegra');
    }
  });

  it('extracts user prose from response_item input_text and assistant prose from output_text', () => {
    const { entries } = codexParseTranscript(fixture, REAL_PATH);
    const user = entries.find((e) => e.role === 'user');
    const assistant = entries.find((e) => e.role === 'assistant');
    expect(user?.text).toContain('AGENTS.md instructions'); // or whatever the fixture user text is
    expect(assistant?.text).toContain('localizar');
  });

  it('skips event_msg mirrors, turn_context, function_call, and session_meta (no double counting)', () => {
    const { entries } = codexParseTranscript(fixture, REAL_PATH);
    // Only message lines become entries; the agent_message/user_message event_msg twins are dropped.
    const roles = entries.map((e) => e.role).sort();
    expect(roles.every((r) => r === 'user' || r === 'assistant')).toBe(true);
  });

  it('multi-turn: every twinned turn captured ONCE (no double-count) AND an event_msg-only turn is NOT dropped (W-NEW-4)', () => {
    const multi = readFileSync(join(__dirname, '__fixtures__/codex/rollout-multiturn.jsonl'), 'utf8');
    const { entries } = codexParseTranscript(multi, REAL_PATH);
    // (a) No double-count: each distinct turn text appears exactly once.
    const texts = entries.map((e) => e.text.replace(/\s+/g, ' ').trim().toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
    // (b) Every distinct user + assistant turn in the fixture is represented (≥3 turns).
    expect(entries.filter((e) => e.role === 'user').length).toBeGreaterThanOrEqual(2);
    expect(entries.filter((e) => e.role === 'assistant').length).toBeGreaterThanOrEqual(1);
    // (c) The event_msg-ONLY turn (no response_item/message twin) is still captured — its
    //     unique marker text from the fixture must be present.
    expect(texts.some((t) => t.includes('event-only turn'))).toBe(true); // adjust to the fixture's marker
  });

  it('groups by FILENAME UUID even on a header-less slice; uses cwdHint for project (W4 resume)', () => {
    // Simulate a cursor-resumed slice: drop the session_meta header line entirely.
    const noMeta = fixture.split('\n').filter((l) => !l.includes('"session_meta"')).join('\n');
    const { entries, cwd } = codexParseTranscript(noMeta, REAL_PATH, '/cached/cwd');
    expect(entries[0]?.sessionId).toBe('019e2658-c8b0-7230-9b59-c3646fbf0c7b'); // filename, no header needed
    expect(entries[0]?.cwd).toBe('/cached/cwd');                                // from the hint
    expect(cwd).toBeUndefined();                                                // no header in this slice
  });

  it('extracts the UUID from REAL rollout filenames (N5 regex regression)', () => {
    const noMeta = '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}\n';
    // Two real on-disk filenames — the timestamp-anchored regex must capture exactly the trailing UUID.
    for (const [path, want] of [
      ['/s/rollout-2026-04-21T13-22-02-019db0d9-471b-7ce0-aa8c-d9e3485a8be1.jsonl', '019db0d9-471b-7ce0-aa8c-d9e3485a8be1'],
      ['/s/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl', '019e2658-c8b0-7230-9b59-c3646fbf0c7b'],
    ] as const) {
      expect(codexParseTranscript(noMeta, path).entries[0]?.sessionId).toBe(want);
    }
  });

  it('never throws on malformed lines — a bad line is a skip', () => {
    expect(() => codexParseTranscript('not json\n{"type":"response_item"}\n', REAL_PATH)).not.toThrow();
  });
});
```

- [ ] **Step 3: Write the parser:**

```typescript
// src/ingest/codex-jsonl.ts
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
 */
import { type ParsedEntry } from './claude-jsonl.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Extract the session UUID from a `rollout-<ts>-<UUID>.jsonl` filename (N5).
 * Anchored on the ISO timestamp shape so the greedy timestamp segment cannot
 * eat into the UUID. Verified against the REAL filenames
 * `rollout-2026-04-21T13-22-02-019db0d9-471b-7ce0-aa8c-d9e3485a8be1.jsonl`
 * and `rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl`.
 */
function sessionIdFromPath(path: string): string | undefined {
  const m = path.match(
    /rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return m?.[1];
}

const INJECTED_WRAPPER =
  /<(system-reminder|command-name|command-message|command-args|command-contents|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g;
function clean(text: string): string {
  return text.replace(INJECTED_WRAPPER, '').replace(/\n{3,}/g, '\n\n').trim();
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
 * Parse a Codex rollout transcript (whole file OR a cursor-resumed slice) into
 * entries. The sessionId is the FILENAME UUID (always present, even mid-file —
 * W4), so a `start > 0` slice that skips the header still groups correctly. The
 * `cwd` comes from `session_meta` when the slice includes it, else from `cwdHint`
 * (supplied by the ingest layer from its kv_meta cache). Never throws — malformed
 * lines are skipped.
 */
export function codexParseTranscript(
  text: string,
  absPath: string,
  cwdHint?: string,
): CodexParseResult {
  const entries: ParsedEntry[] = [];
  const seen = new Set<string>(); // normalized "role text" already captured — de-dup event_msg twins (W-NEW-4)
  const sessionId = sessionIdFromPath(absPath); // FILENAME-derived id (W4)
  let cwd = cwdHint;
  let headerCwd: string | undefined;

  /** Emit a turn unless its normalized text was already captured (de-dup twins; W-NEW-4 no-double-count). */
  const push = (role: 'user' | 'assistant', text: string, timestamp: string | undefined): void => {
    const key = `${role} ${text.replace(/\s+/g, ' ').trim().toLowerCase()}`;
    if (seen.has(key)) return; // a response_item already captured this turn
    seen.add(key);
    entries.push({
      sessionId: sessionId as string,
      role,
      text,
      toolAnchors: [],
      ...(cwd ? { cwd } : {}),
      ...(timestamp ? { timestamp } : {}),
    });
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!isRecord(obj)) continue;
    const type = asString(obj.type);
    const payload = isRecord(obj.payload) ? obj.payload : undefined;

    if (type === 'session_meta' && payload) {
      headerCwd = asString(payload.cwd) ?? headerCwd;
      cwd = headerCwd ?? cwd;
      continue; // session_meta.id is NOT used for grouping — the filename UUID is canonical (W4)
    }
    if (!sessionId) continue;                                  // cannot group without an id (no UUID in filename)

    // --- Primary source: response_item/message (W-NEW-4) ---
    if (type === 'response_item' && payload && payload.type === 'message') {
      const role = asString(payload.role);
      if (role !== 'user' && role !== 'assistant') continue;   // skip 'developer' system turns
      const textOut = extractContent(payload.content);
      if (textOut.length === 0) continue;                      // tool-only / empty
      push(role, textOut, asString(obj.timestamp));            // marks the normalized text as seen
      continue;
    }

    // --- Fallback source: event_msg with NO response_item/message twin (W-NEW-4) ---
    // user_message/agent_message normally MIRROR a response_item/message (same text) and
    // are de-duped by normalized text below; but a turn that exists ONLY as an event_msg
    // (no response_item twin) would otherwise be DROPPED, so capture it here too.
    if (type === 'event_msg' && payload) {
      const evt = asString(payload.type);
      const role = evt === 'user_message' ? 'user' : evt === 'agent_message' ? 'assistant' : undefined;
      if (!role) continue;                                     // skip non-message event_msg types
      const textOut = clean(asString(payload.message) ?? '');
      if (textOut.length === 0) continue;
      push(role, textOut, asString(obj.timestamp));            // de-dup guard inside push() drops twins
      continue;
    }
    // everything else (turn_context, function_call, reasoning, …) is skipped
  }
  return { entries, cwd: headerCwd };
}
```

> Decision: drop `role: 'developer'` turns (the AGENTS.md/system injection in the sample's first user line is actually `role: 'user'` but is the AGENTS.md echo — the `clean()` wrapper-strip handles `<system-reminder>` etc.; the AGENTS.md preamble has no machine boundary so it rides along, same limitation Claude's parser has with skill bodies, #38. Acceptable parity, documented.)

- [ ] **Step 4: Run** `npx vitest run src/ingest/codex-jsonl.test.ts` → PASS (adjust fixture-derived string assertions to your real fixture).

- [ ] **Step 5: Commit**
```bash
git add src/ingest/codex-jsonl.ts src/ingest/codex-jsonl.test.ts src/ingest/__fixtures__/codex/
git commit -m "feat(ingest): Codex rollout transcript parser (#67)"
```

> **Tool-anchor follow-on (out of scope, tracked):** Codex `apply_patch`/`function_call` lines carry file edits in a different shape (`payload.arguments` JSON string, or a `custom_tool_call` for `apply_patch`). Extracting code anchors from them (parity with Claude's Edit/Write anchoring) is a separate work item — file it after this lands. Codex prose capture + recall is fully functional without it.

---

## Task 5: Per-format parser seam in the ingest loop

**Files:** Modify `src/ingest/ingest.ts` · Test `src/ingest/ingest.test.ts`

`ingestFile` (`ingest.ts:190`) calls `parseLine(line)` per line and groups by `entry.sessionId`. Codex lines never satisfy `parseLine`, so route a Codex path through `codexParseTranscript`. **Two hard requirements drive the design:**

1. **W4 — `Stop` fires PER TURN.** `createObservation` (`memory-store.ts:326`) is a plain `INSERT` with NO dedup/UNIQUE/`ON CONFLICT` (verified). So we MUST stream from the persisted byte cursor exactly like Claude — resume from `startOffset`, never re-read prior turns — or each `Stop` re-inserts every earlier turn (quadratic duplicate explosion). Because the Codex sessionId comes from the FILENAME (Task 4), a `start > 0` slice still groups correctly.
2. **C1 — no harness id on the real path.** `dispatchHook('session-end') → handleSessionEnd → ingestSingleSession(memory, transcriptPath)` carries no harness. So the format AND the namespace are derived INSIDE ingest from the path, via `isCodexTranscript(absPath)`. No `harnessId` param is threaded.

Since `ingestFile` already receives `startOffset`, the Codex branch reads the slice from that offset (cursor streaming), feeds it to `codexParseTranscript(slice, absPath, cwdHint)`, then runs each entry through the SAME `resolveSession`/`indexer.write`/`seedAnchors` body the Claude loop uses (extract that body into `writeEntry(...)` so both paths share it — no logic drift). Claude's path stays byte-for-byte unchanged.

- [ ] **Step 1: Write the failing test** — feed a Codex fixture through `ingestSingleSession`, assert one namespaced session + prose observations, AND drive the REAL `handleSessionEnd` path (C1):

```typescript
// add to src/ingest/ingest.test.ts (uses the existing newMemory() helper)
import { handleSessionEnd } from '../hooks/session-end.js';

it('ingests a Codex rollout via ingestSingleSession: one codex:-namespaced session, prose obs (#67)', async () => {
  const memory = newMemory();
  const src = join(__dirname, '__fixtures__/codex/rollout-sample.jsonl');
  // codex-shaped path → the selector picks the Codex parser + the codex: namespace.
  const codexPath = join(dir, '.codex/sessions/2026/05/14/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl');
  mkdirSync(dirname(codexPath), { recursive: true });
  copyFileSync(src, codexPath);
  const result = await ingestSingleSession(memory, codexPath);
  expect(result.observationsAdded).toBeGreaterThan(0);
  const sessions = memory.store.listSessions();
  expect(sessions.length).toBe(1);
  expect(sessions[0]?.externalId).toBe('codex:019e2658-c8b0-7230-9b59-c3646fbf0c7b'); // W1 namespaced
});

it('the REAL dispatch path (handleSessionEnd) namespaces a Codex transcript codex:, Claude stays bare (C1)', async () => {
  const memory = newMemory();
  // Codex transcript at a codex-shaped path.
  const codexPath = join(dir, '.codex/sessions/2026/05/14/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl');
  mkdirSync(dirname(codexPath), { recursive: true });
  copyFileSync(join(__dirname, '__fixtures__/codex/rollout-sample.jsonl'), codexPath);
  // A Claude transcript at a normal projects path.
  const claudePath = join(projectsDir, '-Users-me-foo/sess.jsonl');
  mkdirSync(dirname(claudePath), { recursive: true });
  writeFileSync(claudePath, userLine('claude-sess', '/Users/me/foo', 'hello', 'u1'));
  // Drive the actual hook handler used by dispatch — inject the same `memory`.
  await handleSessionEnd({ transcriptPath: codexPath },  { ingest: (p) => ingestSingleSession(memory, p) });
  await handleSessionEnd({ transcriptPath: claudePath }, { ingest: (p) => ingestSingleSession(memory, p) });
  const ids = memory.store.listSessions().map((s) => s.externalId).sort();
  expect(ids).toEqual(['claude-sess', 'codex:019e2658-c8b0-7230-9b59-c3646fbf0c7b']);
});
```

> The `handleSessionEnd(payload, { ingest })` injection seam already exists (`session-end.test.ts` uses it). This test proves the namespace flows on the REAL path with ZERO harness-awareness in dispatch/handlers — the whole point of C1.

Add a per-line cursor-resume regression (W4/W-NEW-3 — proves cursor streaming, no whole-slice buffer, no re-insert):

```typescript
it('a second Stop on a GROWN Codex rollout appends only new turns — no re-insert of prior turns (W4)', async () => {
  const memory = newMemory();
  const codexPath = join(dir, '.codex/sessions/2026/05/14/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl');
  mkdirSync(dirname(codexPath), { recursive: true });
  // Turn 1: header + one user/assistant message pair.
  writeFileSync(codexPath, [TURN1_META, TURN1_USER, TURN1_ASSISTANT].join('\n') + '\n');
  await ingestSingleSession(memory, codexPath);
  const afterTurn1 = memory.store.counts().observations;
  // Turn 2: append a second user/assistant pair (NO new header — header-less tail).
  appendFileSync(codexPath, [TURN2_USER, TURN2_ASSISTANT].join('\n') + '\n');
  await ingestSingleSession(memory, codexPath);
  const afterTurn2 = memory.store.counts().observations;
  // Only the NEW turn's observations were added; turn 1 was never re-read past the cursor.
  expect(afterTurn2).toBe(afterTurn1 + (afterTurn1)); // 2 obs/turn → exactly +2, never +4
  expect(memory.store.listSessions().length).toBe(1); // still one codex: session (filename UUID)
});
```
> `TURN1_*`/`TURN2_*` are short literal JSONL lines built inline (or sliced from the fixture). The assertion that matters: the second ingest adds EXACTLY the turn-2 observation count, proving the cursor resumed past turn 1 (per-line `offset += Buffer.byteLength(line)+1`) rather than re-buffering the whole file from offset 0.

- [ ] **Step 2: Run** → FAIL (Claude `parseLine` rejects every Codex line; 0 observations; no namespacing).

- [ ] **Step 3: Wire the selector + cursor streaming + cwd cache + namespacing.** In `ingest.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { codexParseTranscript } from './codex-jsonl.js';
// W-R3-1: isCodexTranscript + namespacedExternalId are LEAF helpers in namespacing.ts.
// ingest.ts IMPORTS them (one direction). It does NOT define isCodexTranscript itself.
import { isCodexTranscript, namespacedExternalId } from './namespacing.js';

const CODEX_CWD_PREFIX = 'codex:cwd:'; // kv_meta cache of the header cwd, keyed by transcript path
```

> **Ordering note (W-R3-1):** Task 6 (which creates `namespacing.ts` with `isCodexTranscript`) MUST land before Task 5 Step 3 — the plan already mandates "Do Task 6 first". `ingest.ts` no longer DEFINES `isCodexTranscript`; it imports it from the leaf. The barrel re-export of `isCodexTranscript` (Task 6 Step 3b) sources it from `namespacing.ts`, not `ingest.ts`.

In `ingestFile`, branch once at the top:

- **Codex path (W-NEW-3 — stream PER-LINE like Claude, do NOT buffer the whole slice):** use the SAME `readline` loop Claude uses — `createReadStream(absPath, { start: startOffset })` + `createInterface({ input })` — and advance the cursor PER LINE exactly like Claude: `offset += Buffer.byteLength(line, 'utf8') + 1` after each line (so the two paths share identical cursor accounting and cannot drift). The ONLY difference from Claude is the parser: instead of `parseLine(line)` (one entry per line), feed each line into a **stateful `codexParseTranscript` accumulator** (a Codex parse instance that holds the rolling `cwd`/header state and emits a `ParsedEntry | undefined` per line). Recover the cached header cwd before the loop: `cwdHint = memory.store.getMeta(CODEX_CWD_PREFIX + absPath) ?? undefined`. The sessionId is still the FILENAME UUID (`sessionIdFromPath`), NOT the header — so a header-less mid-file resume still groups (W4). When a line is a `session_meta` header, the accumulator updates its rolling cwd and the loop caches it: `memory.store.setMeta(CODEX_CWD_PREFIX + absPath, cwd)`. Each emitted entry goes through `writeEntry(...)` with `externalId = namespacedExternalId('codex', entry.sessionId)` and `project = entry.cwd ? projectSlug(entry.cwd) : project`.

  > Task 4's `codexParseTranscript(text, absPath, cwdHint)` whole-slice form stays the unit-tested surface; Task 5 adds a thin per-line stateful wrapper (`createCodexLineParser(absPath, cwdHint)` returning `{ pushLine(line): ParsedEntry | undefined; observedCwd(): string | undefined }`) that shares the same line-handling logic — extract the per-line body of `codexParseTranscript` into a function both call, so whole-slice and per-line paths cannot drift. This keeps cursor accounting byte-identical to Claude's per-line `offset += Buffer.byteLength(line)+1`.

- **Claude path:** the existing `for await (const line of rl)` streaming loop verbatim, calling `writeEntry(...)` with `externalId = namespacedExternalId('claude-code', entry.sessionId)` (= bare id — regression-safe).

`writeEntry(memory, sessionCache, bindingCache, externalId, project, entry, absPath, tally)` wraps the resolveSession → indexer.write → seedAnchors body unchanged; both paths call it so there is zero logic drift. BOTH paths advance the cursor per-line via `offset += Buffer.byteLength(line, 'utf8') + 1`, so a grown file resumes from exactly where it stopped — no re-read, no duplicates, and no Codex-vs-Claude cursor-accounting divergence.

> **Why this is correct and dedup-free (W4):** the cursor `>= size` guard in `ingestOneTranscript` (`ingest.ts:289`) skips an unchanged file entirely. When a Codex rollout GROWS (next `Stop`), we read only `[cursor, EOF)` — the new turns — and append them. Prior turns are already past the cursor and are never re-read, so the no-dedup `INSERT` never double-writes them. The filename-UUID sessionId means the header-less tail slice still groups under the right session; the cached cwd gives it the right project. This is the same at-least-once contract Claude already relies on.

> **Dependency:** this step uses `namespacedExternalId` and the path-derived namespace, which Task 6 introduces. **Do Task 6 first** (its helper + unit test), then this step wires it at the seam. The commit below assumes the helper exists.

- [ ] **Step 4: Run** `npm run check` (full suite — the regression gate). Claude ingest tests MUST stay green (the selector only diverts Codex paths). The two new Codex tests pass — including the REAL `handleSessionEnd` C1 test.

- [ ] **Step 5: Commit**
```bash
git add src/ingest/ingest.ts src/ingest/ingest.test.ts
git commit -m "feat(ingest): per-format seam + cursor-streamed Codex ingest, path-derived codex: namespace (W4/C1, #67)"
```

---

## Task 6: W1 — per-harness `external_id` namespacing (migration-safe, path-derived)

**Files:** Create `src/ingest/namespacing.ts` (or add to `src/ingest/session-binding.ts`) · Test `src/ingest/namespacing.test.ts`. **Do this BEFORE Task 5 Step 3** (Task 5 consumes the helper).

**The collision:** `getSessionByExternalId(externalId)` and the `session-project:<externalId>` binding both key by the raw harness session id. With two harnesses on one DB, a Codex `session_meta.id` and a Claude `sessionId` could (theoretically) collide and merge into one store session, mixing two harnesses' transcripts. The design doc (line 117) mandates namespacing the id by source.

**Chosen approach — namespace at the ingest boundary, derived from the PATH (C1):** the harness is NOT threaded as a param (the real `dispatchHook('session-end')` path carries none). Instead `ingestFile` already calls `isCodexTranscript(absPath)` (Task 5) to choose the parser — the SAME classification chooses the namespace. The store stays harness-agnostic (it just sees a different opaque string); the binding key composes naturally (`session-project:codex:019e2658-…`).

**Migration safety (the hard requirement):** every EXISTING Claude session row was written with a RAW (un-prefixed) externalId. Prefixing Claude's ids going forward would orphan all existing rows + bindings. Pick the **leave-Claude-bare** option:

- **Claude keeps bare ids** (no prefix) — its existing rows resolve unchanged, zero migration.
- **Codex (and every future harness) gets a `<harnessId>:` prefix.** Codex is brand-new, so there are no pre-existing bare Codex rows to migrate.

This makes namespacing **additive**: Claude is the un-prefixed "default namespace"; new harnesses are explicitly namespaced. Collision is now impossible (a Codex id is always `codex:…`, never bare). A pure helper keeps the rule in one place:

```typescript
// src/ingest/namespacing.ts — a TRUE LEAF (W-R3-1): depends on NOTHING from ingest.ts or hooks.

/** True when the path is a Codex rollout transcript (drives parser + namespace). */
export function isCodexTranscript(absPath: string): boolean {
  return absPath.includes('/.codex/sessions/') ||
    /\/rollout-\d{4}-\d{2}-\d{2}T[\d-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(absPath);
}

/**
 * Namespace a harness session id for storage (W1, #67). Claude Code keeps its
 * BARE id (migration-safe: existing rows + bindings written before namespacing
 * resolve unchanged). Every other harness is prefixed `<harnessId>:` so two
 * harnesses' colliding raw ids never merge into one store session.
 */
export function namespacedExternalId(harnessId: string, rawSessionId: string): string {
  return harnessId === 'claude-code' ? rawSessionId : `${harnessId}:${rawSessionId}`;
}

/**
 * Derive the harness id from a hook payload's transcript path (C-NEW-1). Every
 * hook payload carries `transcriptPath` (`payload.ts:56-57`), and the path shape
 * is the single source of harness truth. Called once at the dispatch chokepoint
 * (and by ingest for the path-derived capture namespace). No transcript path →
 * assume Claude (bare), the safe default.
 */
export function harnessForPayload(payload: { transcriptPath?: string }): string {
  return payload.transcriptPath && isCodexTranscript(payload.transcriptPath)
    ? 'codex'
    : 'claude-code';
}
```

> **W-R3-1 — `namespacing.ts` is a TRUE LEAF, killing the cycle by construction.** `isCodexTranscript`, `harnessForPayload`, and `namespacedExternalId` are now ALL defined here, depending on nothing. `ingest.ts` IMPORTS `isCodexTranscript` + `namespacedExternalId` FROM `namespacing.ts` (one direction only) — the round-3 `ingest.ts ⇄ namespacing.ts` import cycle (where `namespacing.ts` imported `isCodexTranscript` back from `ingest.ts`) is gone. The barrel `src/ingest/index.ts` re-exports `isCodexTranscript` for external callers (Task 5 used to export it from `ingest.ts`; now it re-exports from `namespacing.ts`, so `ingest.ts` no longer declares it). Verify with `npm run build` (the regression gate runs it).

**How the path drives the harness id:** in `ingestFile`, the Codex branch passes `'codex'` to `namespacedExternalId`; the Claude branch passes `'claude-code'` (= bare). Both branches already KNOW which they are because they were selected by `isCodexTranscript(absPath)` — so the namespace is path-derived, not param-threaded. The binding lookup (`readBinding`) inside `resolveSession` is keyed by the SAME already-namespaced `externalId`, so the binding namespace matches automatically. **No `harnessId` param is added to `ingestSingleSession`/`TranscriptSource`** — that threading was dead on the real capture path (C1).

> **C-NEW-1 — the consent/recall boundaries are covered by the CHOKEPOINT, not per-site (R4).** `set_session_project` is NOT Claude-only: the MCP server runs inside the Codex session and the recall hooks (`SessionStart`/`UserPromptSubmit`) serve Codex. So the notice id, the binding key, and the recall lookups must all use the same namespaced id. Rather than namespacing in each consumer (round 3 did this and still missed 2 sites), **Task 6b namespaces `payload.sessionId` ONCE at the dispatch chokepoint** (`dispatch.ts`), so `session-start.ts` / `user-prompt-submit.ts` / `scope.ts` / `mcp/server.ts` all receive the already-namespaced id with NO per-site change. The bare-vs-prefixed rule is `harnessForPayload(payload)`, derived from the transcript path every hook payload carries.

- [ ] **Step 1: Write the failing unit test (the integration test lives in Task 5):**

```typescript
// src/ingest/namespacing.test.ts
import { describe, expect, it } from 'vitest';
import { harnessForPayload, isCodexTranscript, namespacedExternalId } from './namespacing.js';

describe('isCodexTranscript (W-R3-1 — leaf classifier)', () => {
  it('matches a codex sessions dir and a rollout filename', () => {
    expect(isCodexTranscript('/u/.codex/sessions/2026/05/14/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl')).toBe(true);
  });
  it('rejects a Claude projects path', () => {
    expect(isCodexTranscript('/u/.claude/projects/-x/sess.jsonl')).toBe(false);
  });
});

describe('namespacedExternalId (W1)', () => {
  it('leaves Claude Code ids bare (migration-safe)', () => {
    expect(namespacedExternalId('claude-code', 'abc-123')).toBe('abc-123');
  });
  it('prefixes non-Claude harnesses', () => {
    expect(namespacedExternalId('codex', '019e2658')).toBe('codex:019e2658');
  });
});

describe('harnessForPayload (C-NEW-1)', () => {
  it('classifies a Codex rollout path as codex', () => {
    expect(harnessForPayload({
      transcriptPath: '/u/.codex/sessions/2026/05/14/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl',
    })).toBe('codex');
  });
  it('classifies a Claude projects path as claude-code (bare)', () => {
    expect(harnessForPayload({ transcriptPath: '/u/.claude/projects/-x/sess.jsonl' })).toBe('claude-code');
  });
  it('defaults to claude-code when no transcript path is present', () => {
    expect(harnessForPayload({})).toBe('claude-code');
  });
});
```

> The two-harness-same-raw-id integration assertion is the Task 5 C1 test (`handleSessionEnd` drives a Codex path → `codex:`, a Claude path → bare). Migration safety is proven by the EXISTING Claude session/binding suite staying green (they pass bare ids and still resolve).

- [ ] **Step 2: Run** `npx vitest run src/ingest/namespacing.test.ts` → FAIL (`namespacing.js` missing).

- [ ] **Step 3: Implement** the helper (`namespacedExternalId` + `harnessForPayload`). It is consumed by Task 5 Step 3 (`ingestFile` seam) and Task 6b (hook/recall/MCP boundaries).

- [ ] **Step 3b: Re-export from the ingest barrel.** In `src/ingest/index.ts` add `export { namespacedExternalId, harnessForPayload, isCodexTranscript } from './namespacing.js';` (ALL THREE source from the leaf — W-R3-1; do NOT re-export `isCodexTranscript` from `ingest.ts`, it no longer defines it). The dispatch chokepoint (`src/hooks/dispatch.ts`) imports `namespacedExternalId` + `harnessForPayload` from `../ingest/index.js` (the same barrel it already neighbours for `readBinding`/`writeBinding`).

- [ ] **Step 4: Run** `npx vitest run src/ingest/namespacing.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/ingest/namespacing.ts src/ingest/namespacing.test.ts src/ingest/index.ts
git commit -m "feat(ingest): namespacedExternalId + harnessForPayload helpers — Claude bare, others prefixed (W1/C-NEW-1, #67)"
```

---

## Task 6b: ONE chokepoint namespaces `payload.sessionId` at dispatch (C-NEW-1, R4, CRITICAL)

**Files:** Modify `src/hooks/dispatch.ts` · Test `src/hooks/dispatch.test.ts`, `src/hooks/session-start.test.ts` (Codex notice + Claude regression), `src/recall/scope.test.ts` (Codex recall), `src/mcp/server.test.ts` (single-prefix guard). **Do this AFTER Task 6** (consumes `harnessForPayload`/`namespacedExternalId`). **Revert the round-3 per-site namespacing** in `session-start.ts`, `user-prompt-submit.ts`, `scope.ts` if present (they must NOT call `harnessForPayload`/`namespacedExternalId` — they treat `payload.sessionId` as opaque).

**The class of bug being killed:** rounds 1-3 namespaced the external id at EACH consumer of `payload.sessionId` (the ingest write boundary, then `session-start.ts`, then `user-prompt-submit.ts`, then `scope.ts`). Plan-critic still found a 7th and 8th un-namespaced site (the `abs project` CLI and the MCP `recall` tool). Per-site namespacing is whack-a-mole: every new reader of `payload.sessionId` is a fresh chance to forget the prefix and silently misbind a Codex session.

**The chokepoint fix:** `dispatch.ts` is the SINGLE place every hook payload is born — `parseHookPayload(raw)` runs once, then `handler(payload)`. Namespace `payload.sessionId` THERE, before any handler sees it. After this one mutation the bare id is structurally unreachable on the hook path; every downstream consumer (`session-start.ts`, `user-prompt-submit.ts`, `scope.ts`, `renderNotice`, `readBinding`, `consumeFirstPromptFlag`, `getSessionByExternalId`) uses the already-namespaced `payload.sessionId` verbatim, with ZERO per-site edits. A future hook consumer is namespaced for free.

**Why this covers every hook-path boundary:**
- **Consent notice + binding check** (`session-start.ts`): `renderNotice(payload.sessionId,…)` + `readBinding(store, payload.sessionId)` → both already namespaced.
- **First-prompt** (`user-prompt-submit.ts`): `renderNotice(payload.sessionId,…)`, `readBinding(store, payload.sessionId)` skip-guard, AND `consumeFirstPromptFlag(store, payload.sessionId)` (the `notice-shown:<id>` kv key) → all already namespaced (W-R3-3 covers the Claude kv-key regression below).
- **Recall scope** (`scope.ts`): reached from UserPromptSubmit with `sessionId: payload.sessionId` → already namespaced.
- **Capture** (`session-end.ts`): does NOT read `payload.sessionId` — it namespaces from the transcript PATH inside ingest (Task 5). The chokepoint mutation is inert here; the path-derived and payload-derived strings MUST match (the invariant, verified Task 9 Step 4).

**What is NOT touched (single-application):** the binding WRITER (`set_session_project` in `mcp/server.ts`, and the `abs project --session` CLI in `cli.ts`) receives the namespaced id straight from the notice and treats it as OPAQUE — no re-derivation, no second prefix. Re-namespacing there would produce `codex:codex:…`. A guard test forbids the double-prefix.

- [ ] **Step 1: Write the failing tests.**

```typescript
// add to src/hooks/dispatch.test.ts — the chokepoint namespaces once, for any handler.
it('namespaces payload.sessionId ONCE at dispatch for a Codex transcript (chokepoint, R4)', async () => {
  const seen: string[] = [];
  // Stub a handler-visible payload by routing through a known handler that surfaces sessionId.
  // session-start writes the notice carrying payload.sessionId — assert it is codex:-prefixed.
  const out: string[] = [];
  await dispatchHook('session-start', {
    stdin: stdinOf({
      session_id: '019e2658-c8b0-7230-9b59-c3646fbf0c7b',
      cwd: '/work/proj',
      transcript_path: '/u/.codex/sessions/2026/05/14/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl',
      source: 'startup',
    }),
    stdout: (l) => out.push(l),
  });
  // The injected notice (if any) must carry the namespaced id, never the bare one.
  const joined = out.join('\n');
  if (joined.includes('session=')) {
    expect(joined).toContain('codex:019e2658-c8b0-7230-9b59-c3646fbf0c7b');
    expect(joined).not.toMatch(/session="019e2658-c8b0-7230-9b59-c3646fbf0c7b"/); // never bare for Codex
    expect(joined).not.toContain('codex:codex:'); // single-application guard
  }
});

it('leaves a Claude payload sessionId BARE at dispatch (regression)', async () => {
  const out: string[] = [];
  await dispatchHook('session-start', {
    stdin: stdinOf({
      session_id: 'abc-123', cwd: '/work/proj',
      transcript_path: '/u/.claude/projects/-x/sess.jsonl', source: 'startup',
    }),
    stdout: (l) => out.push(l),
  });
  const joined = out.join('\n');
  if (joined.includes('session=')) expect(joined).toContain('session="abc-123"'); // unchanged byte-for-byte
});
```

> Note: the dispatch test isolates the store via `ABS_DB_PATH` (existing `beforeEach`), so `handleSessionStart` reads an empty store (`hasBinding=false`) and the notice fires. The session-start unit tests below assert the notice text directly via the `gatherFacts` seam — but they now feed an ALREADY-namespaced `sessionId` (because in production the chokepoint did it; the unit handler no longer namespaces). This matches the new contract: handlers receive an opaque, already-namespaced id.

```typescript
// src/hooks/session-start.test.ts — handler is now namespace-AGNOSTIC: it echoes whatever id it is given.
it('renderNotice echoes the (already-namespaced) id it is handed — no re-derivation (R4)', async () => {
  const out = await handleSessionStart(
    // The chokepoint already prefixed it; the handler must NOT prefix again.
    { sessionId: 'codex:019e2658', cwd: '/work/proj' },
    { gatherFacts: async () => ({ sessions: 0, observations: 0, pending: 0, flagged: false, hasBinding: false }) },
  );
  expect(out).toContain('session="codex:019e2658"');
  expect(out).not.toContain('codex:codex:'); // handler does not double-prefix
});
```

```typescript
// src/recall/scope.test.ts — scope is namespace-AGNOSTIC: it looks up the id it is given verbatim.
it('looks up the (already-namespaced) sessionId verbatim — no re-derivation (R4)', () => {
  const store = newStore();                                   // mirror the existing scope test helper
  seedSession(store, { externalId: 'codex:019e2658', project: 'proj' });
  const project = resolveRecallProject(store, {
    scope: 'project',
    sessionId: 'codex:019e2658',                              // the chokepoint already prefixed it
  });
  expect(project).toBe('proj');                               // hits the codex: row directly
});
```

```typescript
// src/mcp/server.test.ts (or wherever setSessionProjectAction is tested) — single-prefix guard.
it('writes the binding under EXACTLY the opaque session id — no double-prefix (R4)', () => {
  const memory = newMemory();                                 // mirror the existing helper
  setSessionProjectAction(memory, { action: 'skip', session: 'codex:abc', confirmDelete: true });
  // The binding key is session-project:codex:abc, never session-project:codex:codex:abc.
  expect(readBinding(memory.store, 'codex:abc')?.action).toBe('skip');
  expect(readBinding(memory.store, 'codex:codex:abc')).toBeNull();
});
```

> **W-R3-3 — Claude kv-key regression (the one key not covered by existing migration assertions):** add an explicit test that `consumeFirstPromptFlag(store, 'abc-123')` (a BARE Claude id) keys `notice-shown:abc-123` exactly — so the chokepoint's no-op-for-Claude path keeps the first-prompt flag byte-identical. Add to `src/hooks/user-prompt-submit.test.ts`:
> ```typescript
> it('consumeFirstPromptFlag keys notice-shown:<bare-id> for a Claude payload (W-R3-3)', () => {
>   const store = newStore();
>   expect(consumeFirstPromptFlag(store, 'abc-123')).toBe(true);   // first call: writes the flag
>   expect(store.getMeta('notice-shown:abc-123')).toBe('1');       // exact bare key
>   expect(consumeFirstPromptFlag(store, 'abc-123')).toBe(false);  // second call: already shown
> });
> ```

> **End-to-end skip reconciliation** (sibling of the Task 5 C1 test): notice id → `writeBinding(codex:<uuid>)` → ingest `resolveBinding(codex:<uuid>)` all key the SAME row. Drive `setSessionProjectAction(memory, { action: 'skip', session: 'codex:019e2658', confirmDelete: true })`, then `ingestSingleSession(memory, codexPath)`, assert ZERO observations (skip honored). Claude equivalent (bare) still skips — regression.

- [ ] **Step 2: Run** → FAIL (dispatch does not namespace; the Codex notice carries the bare id; the single-prefix/W-R3-3 tests are new).

- [ ] **Step 3: Wire the chokepoint (the ONLY namespacing edit on the hook path).** In `src/hooks/dispatch.ts`, import the helpers from the ingest barrel and namespace once after parse:

```typescript
import { harnessForPayload, namespacedExternalId } from '../ingest/index.js';
// … inside dispatchHook's runHookSafely callback, after parse, before handler:
const raw = await readStdin(options.stdin);
const payload = parseHookPayload(raw);
// CHOKEPOINT (R4): namespace the session id ONCE so the bare id never reaches a handler.
// Claude → bare (migration-safe); Codex → codex:<uuid>. Path-derived from transcriptPath.
if (payload.sessionId) {
  payload.sessionId = namespacedExternalId(harnessForPayload(payload), payload.sessionId);
}
return handler(payload);
```

  Then **REVERT** any round-3 per-site namespacing:
  - `session-start.ts` — `handleSessionStart`/`gatherFactsFromStore` pass `payload.sessionId` straight to `readBinding` and `renderNotice` (NO `harnessForPayload`/`namespacedExternalId` import or call). Restore to the clean baseline (matches the current on-disk file, which already has no namespacing — confirm nothing crept in).
  - `user-prompt-submit.ts` — `recallFromStore` passes `payload.sessionId` straight to `readBinding`, `resolveRecallProject`, and `consumeFirstPromptFlag`; the first-prompt notice uses `payload.sessionId ?? ''`. NO namespacing import/call. (Clean baseline.)
  - `scope.ts` — `resolveRecallProject` looks up `sessionId` verbatim (NO `harnessForPayload`/`namespacedExternalId`); it does not need `transcriptPath` for namespacing anymore. (Clean baseline — the `transcriptPath` field stays for the dir fallback only.)
  - `mcp/server.ts` — `setSessionProjectAction` already treats `session` as opaque; VERIFY no prefix is applied (the guard test enforces it). No code change.

  > These reverts are the SHRINK: round 3 added namespacing to 3-4 files; R4 deletes all of it and adds 4 lines to ONE file. The files end up cleaner than round 3 left them.

- [ ] **Step 4: Run** `npm run check` (full suite — the regression gate). The chokepoint + single-prefix + W-R3-3 tests pass; ALL existing Claude session-start/user-prompt/scope/mcp tests stay green (Claude ids are bare ⇒ byte-identical).

- [ ] **Step 5: Commit**
```bash
git add src/hooks/dispatch.ts src/hooks/dispatch.test.ts \
        src/hooks/session-start.test.ts \
        src/hooks/user-prompt-submit.test.ts \
        src/recall/scope.test.ts \
        src/mcp/server.test.ts
git commit -m "fix(harness): chokepoint namespacing at dispatch kills per-site whack-a-mole; single-application guard (C-NEW-1/R4, #67)"
```

---

## Task 7: The Codex adapter

**Files:** Create `src/harness/adapters/codex.ts` · Test `src/harness/adapters/codex.test.ts`

Compose the capabilities: `codexLifecycleInstaller` (Task 3), `cliMcpRegistrar({ binary: 'codex' })` (Task 2), a **payload-only** resolver (no env var — `payloadFirstResolver()` with no `envVar`). `detect()` = `codex` on PATH OR `~/.codex` exists. `qualifies()` = ok (all four pillars present per ground truth).

- [ ] **Step 1: Write the failing test:**

```typescript
// src/harness/adapters/codex.test.ts
import { describe, expect, it } from 'vitest';
import { codexAdapter } from './codex.js';

describe('codexAdapter', () => {
  it('qualifies for full parity', () => {
    expect(codexAdapter().qualifies()).toEqual({ ok: true, missing: [] });
  });

  it('maps Codex native events to canonical moments (Stop = capture, no SessionEnd)', () => {
    const { eventMap } = codexAdapter();
    expect(eventMap.capture).toContain('Stop');
    expect(eventMap.capture).not.toContain('SessionEnd');
    expect(eventMap.recall).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit']));
    expect(eventMap.guard).toContain('PreToolUse');
  });

  it('resolves the session id from the payload only — NO env var fallback', () => {
    const a = codexAdapter();
    expect(a.resolveSession({ payload: { sessionId: 'p1', transcriptPath: '/t.jsonl' } }))
      .toEqual({ sessionId: 'p1', transcriptPath: '/t.jsonl' });
    // A CLAUDE_CODE_SESSION_ID-style env must NOT leak into Codex resolution.
    expect(a.resolveSession({ env: { CLAUDE_CODE_SESSION_ID: 'e1' } })).toBeNull();
  });

  it('registerMcp drives the codex binary (reports already when listed)', async () => {
    const seen: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      seen.push(cmd);
      if (args.includes('--version')) return { code: 0, stdout: 'codex', stderr: '' };
      return { code: 0, stdout: 'agentbrainsystem', stderr: '' };
    };
    expect((await codexAdapter().registerMcp('/cli.js', run)).status).toBe('already');
    expect(seen.every((c) => c === 'codex')).toBe(true);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/harness/adapters/codex.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the adapter:**

```typescript
// src/harness/adapters/codex.ts
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexLifecycleInstaller } from '../capabilities/codex-lifecycle-installer.js';
import { cliMcpRegistrar } from '../capabilities/mcp-registrar.js';
import { payloadFirstResolver } from '../capabilities/session-resolver.js';
import type { HarnessAdapter } from '../types.js';

export function codexAdapter(): HarnessAdapter {
  const resolve = payloadFirstResolver();                 // payload-only — Codex has no session-id env var
  const installer = codexLifecycleInstaller();
  const registrar = cliMcpRegistrar({ binary: 'codex' });
  return {
    id: 'codex',
    displayName: 'Codex CLI',
    mcpBinary: 'codex',                                   // C2: cmdUninstall routes MCP unregister to this binary
    detect: async () => {
      try { await access(join(homedir(), '.codex')); return true; } catch { return false; }
    },
    qualifies: () => ({ ok: true, missing: [] }),
    eventMap: {
      capture: ['Stop'],                                  // Codex has NO SessionEnd
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

> **`HarnessAdapter` gains an optional `mcpBinary?: string`** (the CLI that owns `mcp add/list/remove`). The Claude adapter sets `mcpBinary: 'claude'` (or omits it → defaults to `'claude'` at the call site); Codex sets `'codex'`. This is what `cmdUninstall` reads to route the MCP unregister (C2). Add the field to `src/harness/types.ts` in this task and set it on the Claude adapter (`src/harness/adapters/claude-code.ts`) — a one-line, regression-safe add.
>
> **C2 correction — `cmdUninstall` is NOT `--harness`-aware today.** `cmdInstallHooks` (`cli.ts:402`) and `cmdSetup` (`cli.ts:447`) DO call `resolveHarnesses(args)` and loop adapters. But `cmdUninstall` (`cli.ts:523`) does NOT: it hardcodes `defaultRegistry().byId('claude-code')` (`cli.ts:528`) for hooks and calls `unregisterMcpServer(spawnCapture)` (`cli.ts:537`) with the Claude default binary — `abs uninstall --harness codex` would silently uninstall CLAUDE, never Codex. **Task 8 REWRITES `cmdUninstall`** to mirror the install path. This is a real code rewrite, not a footnote follow-on.

- [ ] **Step 4: Run** `npx vitest run src/harness/adapters/codex.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/harness/adapters/codex.ts src/harness/adapters/codex.test.ts
git commit -m "feat(harness): Codex CLI adapter — composes capabilities, payload-only session id (#67)"
```

---

## Task 8: Register Codex in `defaultRegistry()` + make `cmdUninstall` `--harness`-aware (C2)

**Files:** Modify `src/harness/index.ts`, `src/harness/types.ts`, `src/harness/adapters/claude-code.ts`, `src/cli/cli.ts` · Test `src/harness/index.test.ts`, `src/cli/cli.test.ts`

- [ ] **Step 1: Write the failing tests:**

```typescript
// add to src/harness/index.test.ts
it('includes the Codex adapter', () => {
  expect(defaultRegistry().byId('codex')?.displayName).toBe('Codex CLI');
});

// add to src/cli/cli.test.ts (resolveHarnesses block)
it('--harness codex resolves the qualifying Codex adapter', () => {
  const result = resolveHarnesses(['--harness', 'codex']);
  expect(result?.map((a) => a.id)).toEqual(['codex']);
});

// add to src/cli/cli.test.ts — C2: uninstall must target the SELECTED harness, not always Claude.
it('cmdUninstall --harness codex uninstalls Codex hooks and unregisters the codex MCP binary', async () => {
  const calls: string[][] = [];
  // Inject the run/registry seam the CLI uses for spawn (mirror the existing setup/uninstall test injection).
  // The codex adapter's uninstall() removes the [hooks] block; the MCP unregister must drive `codex`, not `claude`.
  await cmdUninstall(['--harness', 'codex'], { run: (cmd, args) => { calls.push([cmd, ...args]); return Promise.resolve({ code: 0, stdout: '', stderr: '' }); } });
  // Every MCP-unregister invocation targets the codex binary.
  const mcpCalls = calls.filter((c) => c.includes('mcp'));
  expect(mcpCalls.length).toBeGreaterThan(0);
  expect(mcpCalls.every((c) => c[0] === 'codex')).toBe(true);
});
```

> The exact injection shape depends on how the existing `cmdUninstall` test stubs `spawnCapture`. Mirror the established pattern in `cli.test.ts` (the setup/uninstall tests already inject a fake `run`); the assertion that matters is **the MCP unregister binary is `codex`, never `claude`, under `--harness codex`**, and that `adapter.uninstall()` (not the hardcoded Claude one) is what removes the hooks.

- [ ] **Step 2: Run** → FAIL (`codex` not registered; `cmdUninstall` ignores `--harness` and hits the Claude binary).

- [ ] **Step 3a: Register the adapter.** In `src/harness/index.ts`:

```typescript
import { codexAdapter } from './adapters/codex.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';
// …
if (!cached) cached = createRegistry([claudeCodeAdapter(), codexAdapter()]);
```

- [ ] **Step 3b: Add `mcpBinary` to the contract.** In `src/harness/types.ts` add `mcpBinary?: string;` to `HarnessAdapter`. In `src/harness/adapters/claude-code.ts` set `mcpBinary: 'claude'` (regression-safe — it was the implicit default). Codex already sets `'codex'` (Task 7).

- [ ] **Step 3c: REWRITE `cmdUninstall` to be `--harness`-aware (C2).** Replace the hardcoded `byId('claude-code')` + bare `unregisterMcpServer(spawnCapture)` with the install-path pattern:

```typescript
async function cmdUninstall(args: string[]): Promise<void> {
  const purge = args.includes('--purge');
  const yes = args.includes('--yes');

  const harnesses = resolveHarnesses(args);          // mirrors cmdInstallHooks:402 / cmdSetup:447
  if (!harnesses) return;

  for (const adapter of harnesses) {
    // 1. Remove this adapter's lifecycle wiring (TOML for codex, settings.json for claude).
    const hooks = await adapter.uninstall();
    out(hooks.removed.length > 0
      ? `✓ hooks removed (${adapter.displayName}): ${hooks.removed.join(', ')}`
      : `✓ no abs hooks were present (${adapter.displayName})`);

    // 2. Unregister the MCP server with THIS adapter's CLI binary (C2 — not always claude).
    const reg = await unregisterMcpServer(spawnCapture, { binary: adapter.mcpBinary ?? 'claude' });
    switch (reg.status) {
      case 'removed':        out(`✓ MCP server "${MCP_SERVER_NAME}" unregistered from ${adapter.displayName}`); break;
      case 'not-registered': out(`✓ MCP server "${MCP_SERVER_NAME}" was not registered (${adapter.displayName})`); break;
      case 'no-claude':      out(`! ${adapter.mcpBinary ?? 'claude'} CLI not found — unregister manually:`); out(`    ${reg.manualCommand}`); break;
      case 'error':          out(`! Could not auto-unregister (${reg.message}). Run manually:`); out(`    ${reg.manualCommand}`); break;
    }
  }

  // 3. Memory store: preserved by default, hard-deleted only with --purge (unchanged).
  const config = loadConfig();
  if (purge) await purgeStore(config.dbPath, yes);
  // … the rest of the existing post-purge messaging is unchanged.
}
```

(The `unregisterMcpServer(run, { binary })` signature is Task 1's generalized form. Keep the no-flag default selecting Claude only, so `abs uninstall` with no `--harness` stays byte-identical for existing users.)

- [ ] **Step 3d: Fix the dual-writer ordering in `cmdSetup` (W1-warn).** For Codex, BOTH `adapter.registerMcp()` (which shells `codex mcp add`, mutating `config.toml`'s `[mcp_servers.*]`) AND `adapter.install()` (our `[hooks]` TOML splice) write the SAME file. Today `cmdSetup` (`cli.ts:455,459`) runs `install()` FIRST, then `registerMcp()`. **Reorder so `registerMcp()` runs FIRST, then `install()`** — so Codex's own writer mutates the file before our splice reads-merges-writes, and our sentinel block is the last thing written (it can't be clobbered by codex's writer):

```typescript
// cmdSetup — Codex-safe ordering: codex mutates config.toml first, our splice last.
const cliPath = fileURLToPath(import.meta.url);
const reg = await adapter.registerMcp(cliPath, spawnCapture);   // codex mcp add → writes [mcp_servers.*]
// … report reg.status (unchanged switch) …
const hooks = await adapter.install();                          // our [hooks] splice — reads codex's fresh file
if (hooks.wired.length > 0) out(`✓ hooks registered: ${hooks.wired.join(', ')}`);
```

> For Claude this reorder is inert (hooks live in `settings.json`, MCP in a separate registry — no shared file), so the existing Claude `setup` test stays green. **Acceptance (Task 9):** after `setup --harness codex`, run `install-hooks --harness codex` again and assert NO duplicate `[[hooks.Stop]]` — i.e. our sentinels survived codex's writer. If a future codex version's writer STRIPS comments (killing our sentinels), the fallback is a non-comment sentinel (a dedicated `[hooks._abs_managed]` marker table) — note this as a known fragility, not implemented now.

- [ ] **Step 4: Run** `npm run check` — full suite green (existing no-flag uninstall + setup tests still pass; the new `--harness codex` test passes).

- [ ] **Step 5: Commit**
```bash
git add src/harness/index.ts src/harness/index.test.ts src/harness/types.ts src/harness/adapters/claude-code.ts src/cli/cli.ts src/cli/cli.test.ts
git commit -m "feat(harness): register Codex + rewrite cmdUninstall to be --harness-aware via adapter.mcpBinary (C2, #67)"
```

---

## Task 9: Acceptance — wire a real Codex install (manual verification)

**Files:** none (verification). Build first (`npm run build`) — `npm run check` does NOT rebuild `dist`, and the `abs` CLI runs from `dist`.

- [ ] **Step 1:** `npm run build`
- [ ] **Step 2:** `abs install-hooks --harness codex` → prints `registered hooks (Codex CLI): capture, recall, guard`. **W3:** when the current project is NOT trusted, the output ALSO carries the trust warning (`… set trust_level = "trusted" … or the hooks will never fire`); when trusted, no warning. Inspect `~/.codex/config.toml`: a single managed block with `[[hooks.Stop]]`/`[[hooks.SessionStart]]`/`[[hooks.UserPromptSubmit]]`/`[[hooks.PreToolUse]]`, and a fresh `.bak` beside it. Re-run → no duplication, no new `.bak` from a no-op.
- [ ] **Step 3:** `abs setup --harness codex` → registers MCP FIRST then installs hooks (W1-warn ordering); confirm `codex mcp list` now lists `agentbrainsystem`, and `config.toml` gained a `[mcp_servers.agentbrainsystem]` table (written by `codex mcp add`, not by us).
- [ ] **Step 3b (W1-warn):** Immediately re-run `abs install-hooks --harness codex` and grep `~/.codex/config.toml` for `[[hooks.Stop]]` → assert EXACTLY ONE occurrence (our sentinel block survived codex's own `config.toml` writer; no duplicate hooks).
- [ ] **Step 4:** Run a short real Codex session in a **trusted** project, then on `Stop` confirm `abs` captured it: `abs recall "<something you said>"` (or inspect the store) shows the Codex session's prose under the project's cwd, stored under a `codex:`-prefixed external id. Send a SECOND turn (another `Stop`) and confirm the store does NOT double-count the first turn's observations (W4 — cursor streaming, no re-insert). Confirm a new session opens with recalled context injected (recall on `SessionStart`/`UserPromptSubmit`).
- [ ] **Step 5:** `abs uninstall --harness codex` → removes the managed `[hooks]` block (other tables intact) AND unregisters the MCP server from CODEX (`codex mcp list` no longer lists it — proving C2: the unregister hit the `codex` binary, not `claude`).
- [ ] **Step 6 (regression):** `abs install-hooks` (no flag) still wires Claude Code exactly as before; `~/.claude/settings.json` unaffected; `abs uninstall` (no flag) still targets Claude only.

> **Trust gate (W3, confirmed in the binary).** The installed `0.125.0` binary contains the strings `"skipping managed hooks from "` and `" is marked as untrusted in "` — Codex SILENTLY skips `config.toml`-managed hooks in untrusted projects. So a wired `[hooks]` block in an untrusted project NEVER fires (looks like an `abs` bug; it is Codex policy). The project must be trusted (`config.toml` `[projects."<cwd>"] trust_level = "trusted"`). This is now surfaced as a real output warning at install time (Task 3 W3) and asserted in Step 2. Also note it in `docs/agent-handbook.md` (closure doc update).

---

## Self-review checklist (run before declaring #67 done)

- [ ] `npm run check` fully green (lint + typecheck + all tests).
- [ ] Claude Code path is byte-identical: `abs install-hooks` / `abs setup` / `abs uninstall` (no `--harness`) produce the same `settings.json`, same `claude mcp add`/`claude mcp remove` argv as before (Task 1 regression test + existing suite prove it).
- [ ] No core module imports `src/harness` (`git grep -n "from '.*harness" src/store src/recall src/embedding src/optimize` → only the W1 helper lives in `src/ingest`, which is allowed).
- [ ] The Codex parser is exercised by a REAL transcript fixture — `src/ingest/__fixtures__/codex/rollout-sample.jsonl`; the TOML installer is exercised by a REAL-config fixture — `src/harness/capabilities/__fixtures__/codex/config.toml`.
- [ ] **C1:** the REAL `handleSessionEnd` path (no harness param) namespaces a Codex transcript `codex:` and a Claude one bare — proven by the Task 5 integration test driving `handleSessionEnd` directly. No `harnessId` param threaded through `ingestSingleSession`/`TranscriptSource`.
- [ ] **C-NEW-1 / R4 (chokepoint):** `payload.sessionId` is namespaced ONCE at `dispatch.ts` (after `parseHookPayload`, before any handler) — NOT per-site. `session-start.ts`/`user-prompt-submit.ts`/`scope.ts`/`mcp/server.ts` carry NO `harnessForPayload`/`namespacedExternalId` call (round-3 per-site namespacing REVERTED — verified by grep: only `dispatch.ts` and `ingest.ts` reference these helpers). The Codex SessionStart notice carries the `codex:`-prefixed id; a Codex skip reconciles end-to-end (notice → `writeBinding` → ingest `resolveBinding` all key `codex:<uuid>`); Codex session-scoped recall hits the `codex:` row; `set_session_project` + `abs project --session` apply the prefix exactly ONCE (single-application guard test forbids `codex:codex:`); Claude notice/binding/recall/kv stay bare (regression, incl. W-R3-3 `notice-shown:<bare-id>`).
- [ ] **Path-vs-payload INVARIANT:** capture (path-derived `codex:<filename-uuid>`) and recall/consent (payload-derived `codex:<payload session_id>`) bind the SAME store row because `filename UUID == session_meta.id == hook payload session_id` (ground truth line 81 + Task 9 Step 4 real-`Stop` verification). Stated explicitly; a mismatch would silently misbind.
- [ ] **W-R3-1 (cycle):** `namespacing.ts` is a TRUE LEAF — it DEFINES `isCodexTranscript` + `harnessForPayload` + `namespacedExternalId`, importing nothing from `ingest.ts`/hooks. `ingest.ts` imports `isCodexTranscript`/`namespacedExternalId` FROM it (one direction). The barrel re-exports all three from `namespacing.ts`. `npm run build` confirms no cycle.
- [ ] **Accepted degradations (documented, NOT fixed):** (1) the MCP `recall` TOOL is cwd-scoped for Codex (no payload → no harness); the auto-recall pillar runs via the namespaced UserPromptSubmit HOOK. (2) `abs project` for Codex REQUIRES explicit `--session codex:<uuid>` (no env autodetect); guard test asserts single-prefix write.
- [ ] **W4:** Codex ingest streams from the byte cursor (NOT offset 0); a second `Stop` does not re-insert prior turns (verified: `createObservation` has no dedup). sessionId is from the FILENAME; header `cwd` is cached in kv_meta for header-less resumes.
- [ ] **N5:** the rollout regex is timestamp-anchored and tested against two REAL filenames.
- [ ] **C2:** `cmdUninstall` is `--harness`-aware (rewritten to `resolveHarnesses` + per-adapter `mcpBinary`); `abs uninstall --harness codex` removes Codex hooks AND unregisters the `codex` MCP binary — proven by a CLI test.
- [ ] **C3:** TOML install is byte-identical across 3 runs over the real-config fixture and the result re-parses as valid TOML (dev-only `@iarna/toml`, never a runtime dep); ONE `normalize()` owns newline handling.
- [ ] **W1-warn:** `cmdSetup --harness codex` registers MCP before splicing hooks; a re-`install-hooks` shows no duplicate `[[hooks.Stop]]`.
- [ ] **W3:** untrusted-project trust warning is surfaced at install time and asserted.
- [ ] **W-NEW-1:** `@iarna/toml@^2.2.5` pinned in `devDependencies` only (test import only, no runtime dep).
- [ ] **W-NEW-2:** the trust assertion runs against a REAL cwd row present in the real-config fixture (not only synthetic `/work/foo`).
- [ ] **W-NEW-3:** Codex ingest streams PER-LINE via the SAME `readline` loop + per-line `offset += Buffer.byteLength(line)+1` as Claude (a stateful accumulator feeds lines), not a whole-slice buffer — proven by the grown-rollout cursor-resume test.
- [ ] **W-NEW-4:** a multi-turn fixture proves no double-count of twinned turns AND no drop of an `event_msg`-only turn.
- [ ] **W2:** `eventMap` and the TOML installer use only the 6 real `0.125.0` events (`Stop`/`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PermissionRequest`/`PostToolUse`); no phantom PreCompact/Subagent; `Stop` (not `SessionEnd`) is capture.
- [ ] Namespacing is migration-safe: an existing bare Claude `external_id` still resolves (existing session/binding tests pass unchanged); a Codex id is always `codex:`-prefixed.
- [ ] `qualifies()` for Codex returns `{ ok: true, missing: [] }`; `resolveSession` is payload-only (no env leak).

---

## Out of scope (tracked follow-ons, not this issue)

- **Codex tool-anchor extraction** — anchoring code edits from `apply_patch`/`function_call` lines (Codex shape ≠ Claude `tool_use`). Codex ships prose-only capture here; anchoring is a separate plan.
- ~~**Codex `set-session-project`**~~ — RECLASSIFIED IN-SCOPE by C-NEW-1 (Task 6b). The notice id, the `set_session_project` binding key, and the recall lookups all reconcile via the dispatch CHOKEPOINT (R4) — `payload.sessionId` is namespaced once, so every hook-path consumer keys the same `codex:<uuid>`. No longer a follow-on.
- **MCP `recall` TOOL cwd-scope for Codex** — ACCEPTED DEGRADATION (documented, not fixed). The MCP `recall` tool has no hook payload → no harness → resolves via the Claude env adapter (undefined for Codex) → cwd-scoped recall. The auto-recall PARITY PILLAR is the namespaced UserPromptSubmit HOOK path; the manual tool degrading to cwd-scope for Codex is acceptable. Threading a harness hint into the MCP tool is a separate item.
- **`abs project` requires `--session` for Codex** — ACCEPTED DEGRADATION (documented). Codex has no env session id, so bare interactive `abs project` cannot resolve a Codex session; the notice instructs the agent to pass `--session codex:<uuid>` (or use the MCP tool). The CLI treats `--session` as opaque (single-prefix guard test).
- **Comment-stripping fallback sentinel** — if a future Codex `config.toml` writer strips comments (killing our `# >>> … >>>` sentinels), switch to a non-comment marker table. Not needed for `0.125.0`.
- **Auto-detect install** — `abs install-hooks`/`abs setup` with NO flag installing for ALL `detectInstalled()` harnesses (cross-adapter). The framework supports it (`detectInstalled()`); enabling it for both harnesses at once is a cross-cutting UX item.
