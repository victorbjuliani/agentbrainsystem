# Codex CLI Harness Adapter — Implementation Plan (#67)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD throughout: failing test first, then code, then green, then commit.

**Goal:** Ship the Codex CLI as the **second** qualifying harness behind the Phase-0 `HarnessAdapter` contract — auto-capture + auto-recall + MCP + stable session id — proving the abstraction survives a genuinely different harness, and introducing per-harness `external_id` namespacing (W1) the first time two harnesses coexist on one `memory.db`.

**Architecture:** A new `src/harness/adapters/codex.ts` composes the existing capabilities. Two capability generalizations are required because Codex differs from Claude on the two harness-coupled axes the Phase-0 plan deferred to here:

1. **MCP registration** — `registerMcpServer` is hardcoded to the `claude` binary. Generalize it to take a CLI binary + an `mcp add`/`mcp list`/`mcp remove` argv builder, so it drives both `claude mcp add agentbrainsystem -- node <cli> start` and `codex mcp add agentbrainsystem -- node <cli> start`. Claude behavior stays byte-identical (regression gate).
2. **Lifecycle install** — Codex hooks are NOT in `~/.claude/settings.json`; they live in `~/.codex/config.toml` under a `[hooks]` table (TOML, matcher-group arrays per PascalCase event). A new `CodexLifecycleInstaller` capability owns the TOML read/merge/write, idempotent + backup-first, mirroring `installHooks`'s safety contract but for TOML.

A third change is the **transcript parser**: Codex's rollout JSONL schema is fundamentally different from Claude's (different line `type`s, session id only in the header line, content blocks named `input_text`/`output_text` not `text`). A `codexParseTranscript` variant handles it; the JSONL ingest loop gains a per-format parser seam so Claude's path is untouched.

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
- The native binary's `HookEventName` enum (confirmed via `strings` + Context7 `/openai/codex` `codex-rs/protocol/src/protocol.rs`) is **Claude-derived, PascalCase**:
  ```rust
  pub enum HookEventName {
      PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact,
      SessionStart, UserPromptSubmit, SubagentStart, SubagentStop, Stop,
  }
  ```
  **There is NO `SessionEnd`.** The session-finished moment is **`Stop`** (Claude's `SessionEnd` has no Codex equivalent; `Stop` is the closest "the agent finished a turn / session is idle" signal — the same role the design doc's table assigns it: `CapturePoint = Stop`).
- A registered hook's identity key (from `hooks/list`, Context7 app-server README) is
  `"/Users/me/.codex/config.toml:pre_tool_use:0:0"` — i.e. `<sourcePath>:<snake_case_event>:<group_index>:<hook_index>`. The on-disk event keys are **snake_case** (`pre_tool_use`), the protocol enum is PascalCase. Hook entry fields: `eventName`, `handlerType: "command"`, `command`, `timeoutSec`, `matcher`, `source`, `enabled`.
- Each event is an **array of matcher groups**, each group `{ matcher, hooks: [{ type/handler, command, timeout }] }` — the **same shape as Claude's `hooks.<Event>[]`** in settings.json, just expressed as TOML under `config.toml`.

### Hook stdin payload
The hook handler is spawned with the hook JSON on **stdin** (same model as Claude). The payload carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` — the exact snake_case fields `parseHookPayload` (`src/hooks/payload.ts:54-61`) already reads. **No code change to `parseHookPayload` is needed for Codex.** Codex exposes **no session-id env var** (there is no `CODEX_*` equivalent of `CLAUDE_CODE_SESSION_ID`), so the Codex resolver is **payload-only** (no env-var fallback).

### Transcript schema — REAL sample (`~/.codex/sessions/2026/05/14/rollout-…-019e2658-c8b0-….jsonl`)
The filename embeds the session UUID: `rollout-<ISO-ts>-<UUID>.jsonl`, and that UUID equals `session_meta.payload.id`.

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

**Design consequence:** Codex needs a **stateful** parser — read `session_meta` first to capture `{ sessionId, cwd }`, then map each subsequent `response_item`/`event_msg` to a `ParsedEntry` carrying that header's sessionId+cwd. The session id is also recoverable from the filename UUID as a fallback if `session_meta` is absent (resumed/forked sessions still have the header, but the fallback is cheap insurance). To avoid double-counting, we extract prose from **`response_item.message`** lines (the canonical conversation record) and **skip the `event_msg` mirror** (`user_message`/`agent_message` duplicate the same text — confirmed in the sample: identical strings).

### W1 collision risk (real, now reachable)
Both harnesses use UUID session ids. Claude's `sessionId` and Codex's `session_meta.id` are both v7-style UUIDs from independent generators. A collision is astronomically unlikely **by value**, but the store keys sessions by `external_id` with a `UNIQUE`-style lookup (`getSessionByExternalId` → `SELECT … WHERE external_id = ?`), and the **`session-project:<externalId>` binding** is keyed the same way. The design doc (line 117) mandates **namespacing the session id by source**. We do it now (Task 6), the first time two harnesses share one DB, and make it **migration-safe** so every existing Claude `external_id` still resolves.

---

## File map

- **Modify** `src/cli/setup.ts` — generalize `registerMcpServer`/`unregisterMcpServer` to a CLI binary + argv builder (Task 1).
- **Modify** `src/harness/capabilities/mcp-registrar.ts` — `cliMcpRegistrar` accepts the binary (Task 2).
- **Create** `src/harness/capabilities/codex-lifecycle-installer.ts` — TOML `[hooks]` installer (Task 3).
- **Create** `src/ingest/codex-jsonl.ts` — Codex transcript parser (Task 4) + tool-anchor follow-on (Task 5 scope note).
- **Modify** `src/ingest/ingest.ts` — per-format parser seam (Task 5).
- **Modify** `src/store/memory-store.ts` + `src/ingest/session-binding.ts` + `src/ingest/ingest.ts` — W1 `external_id` namespacing (Task 6).
- **Create** `src/harness/adapters/codex.ts` — the adapter (Task 7).
- **Modify** `src/harness/index.ts` — register Codex in `defaultRegistry()` (Task 8).
- Tests alongside each (`*.test.ts`), plus real-transcript fixtures under `src/ingest/__fixtures__/codex/`.

The core (`src/store` excepting the one namespacing helper, `src/recall`, `src/embedding`, `src/optimize`) stays harness-agnostic; nothing there imports `src/harness`.

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
});
```

- [ ] **Step 2: Run** `npx vitest run src/harness/capabilities/codex-lifecycle-installer.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the capability.** Mirror `installer.ts`'s safety primitives (symlink refusal, backup-first, atomic temp+rename) but operate on the raw TOML text + a managed sentinel block. Pseudostructure:

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

export interface CodexInstallerOptions { configPath?: string; baseCommand?: string; }
export interface LifecycleInstaller { install(): Promise<InstallReport>; uninstall(): Promise<UninstallReport>; }

function defaultConfigPath(): string { return join(homedir(), '.codex', 'config.toml'); }

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

/** Strip an existing managed block (idempotency + uninstall). Returns text with the block + its surrounding blank lines removed. */
function stripManaged(toml: string): string {
  const b = toml.indexOf(BEGIN);
  if (b < 0) return toml;
  const e = toml.indexOf(END, b);
  if (e < 0) return toml; // malformed — leave as-is rather than nuke
  const before = toml.slice(0, b).replace(/\n+$/, '\n');
  const after = toml.slice(e + END.length).replace(/^\n+/, '');
  return `${before}${after ? `\n${after}` : ''}`;
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
      const current = readText(configPath);
      const stripped = stripManaged(current);
      const block = renderBlock(baseCommand);
      const next = stripped.trim().length > 0 ? `${stripped.replace(/\n+$/, '\n')}\n${block}\n` : `${block}\n`;
      if (next === current) return { wired: MOMENTS };
      backup(configPath);
      atomicWrite(configPath, next);
      return { wired: MOMENTS };
    },
    uninstall: async () => {
      assertNotSymlink(configPath);
      const current = readText(configPath);
      if (!current.includes(BEGIN)) return { removed: [] };
      backup(configPath);
      atomicWrite(configPath, stripManaged(current).replace(/\n{3,}/g, '\n\n'));
      return { removed: MOMENTS };
    },
  };
}
```

> Idempotency contract: install always strips any prior managed block then re-appends a freshly rendered one. Re-running with the same `baseCommand` reproduces byte-identical text (test 2 asserts this), so the early `next === current` return makes the second run a true no-op (no backup, no write).

- [ ] **Step 4: Run** `npx vitest run src/harness/capabilities/codex-lifecycle-installer.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/harness/capabilities/codex-lifecycle-installer.ts src/harness/capabilities/codex-lifecycle-installer.test.ts
git commit -m "feat(harness): Codex TOML [hooks] lifecycle installer (#67)"
```

---

## Task 4: Codex transcript parser (`codex-jsonl.ts`)

**Files:** Create `src/ingest/codex-jsonl.ts` · Test `src/ingest/codex-jsonl.test.ts` · Fixtures `src/ingest/__fixtures__/codex/*.jsonl`

The parser is **stateful per file**: a `session_meta` line seeds `{ sessionId, cwd }`; conversation prose is taken from `response_item` `message` lines; `event_msg` mirrors and machine lines are skipped. Reuses `ParsedEntry`/`normalizeWorktreePath` from `claude-jsonl.ts` (import them — do not duplicate). Tool-anchor extraction from `function_call`/`apply_patch` lines is **out of scope for this task** (see scope note); `toolAnchors` is always `[]` for now, so Codex contributes prose-only observations (still a full capture/recall win; anchoring is a follow-on).

- [ ] **Step 1: Create a real fixture.** Copy ~12 representative lines from a real rollout into `src/ingest/__fixtures__/codex/rollout-sample.jsonl` — at minimum: one `session_meta`, one `response_item`/`message`/`user` (with `input_text`), one `response_item`/`message`/`assistant` (with `output_text`), one `response_item`/`function_call`, one `event_msg`/`user_message`, one `event_msg`/`agent_message`, one `turn_context`. Strip any secrets (auth tokens, full base_instructions text — truncate to a short stub). Keep the structural shapes intact.

- [ ] **Step 2: Write the failing test:**

```typescript
// src/ingest/codex-jsonl.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexParseTranscript } from './codex-jsonl.js';

const fixture = readFileSync(join(__dirname, '__fixtures__/codex/rollout-sample.jsonl'), 'utf8');

describe('codexParseTranscript', () => {
  it('seeds sessionId + cwd from session_meta and applies them to every entry', () => {
    const entries = codexParseTranscript(fixture, '/abs/rollout-…-019e2658-c8b0-….jsonl');
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.sessionId).toBe('019e2658-c8b0-7230-9b59-c3646fbf0c7b');
      expect(e.cwd).toBe('/Users/.../PGIntegra');
    }
  });

  it('extracts user prose from response_item input_text and assistant prose from output_text', () => {
    const entries = codexParseTranscript(fixture, '/abs/x.jsonl');
    const user = entries.find((e) => e.role === 'user');
    const assistant = entries.find((e) => e.role === 'assistant');
    expect(user?.text).toContain('AGENTS.md instructions'); // or whatever the fixture user text is
    expect(assistant?.text).toContain('localizar');
  });

  it('skips event_msg mirrors, turn_context, function_call, and session_meta (no double counting)', () => {
    const entries = codexParseTranscript(fixture, '/abs/x.jsonl');
    // Only message lines become entries; the agent_message/user_message event_msg twins are dropped.
    const roles = entries.map((e) => e.role).sort();
    expect(roles.every((r) => r === 'user' || r === 'assistant')).toBe(true);
  });

  it('falls back to the filename UUID when session_meta is absent', () => {
    const noMeta = fixture.split('\n').filter((l) => !l.includes('"session_meta"')).join('\n');
    const entries = codexParseTranscript(noMeta, '/x/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl');
    expect(entries[0]?.sessionId).toBe('019e2658-c8b0-7230-9b59-c3646fbf0c7b');
  });

  it('never throws on malformed lines — a bad line is a skip', () => {
    expect(() => codexParseTranscript('not json\n{"type":"response_item"}\n', '/x.jsonl')).not.toThrow();
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
 * `user_message`/`agent_message` lines mirror the same text and are SKIPPED to
 * avoid double-counting. Tool calls are separate `function_call` lines (anchoring
 * from them is a follow-on; this parser emits prose only).
 */
import { type ParsedEntry } from './claude-jsonl.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Extract the session UUID from a `rollout-<ts>-<UUID>.jsonl` filename. */
function sessionIdFromPath(path: string): string | undefined {
  const m = path.match(/rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/i);
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

/**
 * Parse a whole Codex rollout transcript into ParsedEntry[]. Stateful: the
 * leading `session_meta` seeds sessionId+cwd; the filename UUID is the fallback.
 * Never throws — malformed lines are skipped.
 */
export function codexParseTranscript(text: string, absPath: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let sessionId = sessionIdFromPath(absPath);
  let cwd: string | undefined;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!isRecord(obj)) continue;
    const type = asString(obj.type);
    const payload = isRecord(obj.payload) ? obj.payload : undefined;

    if (type === 'session_meta' && payload) {
      sessionId = asString(payload.id) ?? sessionId;
      cwd = asString(payload.cwd) ?? cwd;
      continue;
    }
    if (type !== 'response_item' || !payload) continue;       // skip event_msg/turn_context/etc
    if (payload.type !== 'message') continue;                  // skip function_call/reasoning/etc
    const role = asString(payload.role);
    if (role !== 'user' && role !== 'assistant') continue;     // skip 'developer' system turns
    const sid = sessionId;
    if (!sid) continue;                                        // cannot group without an id
    const textOut = extractContent(payload.content);
    if (textOut.length === 0) continue;                        // tool-only / empty
    entries.push({
      sessionId: sid,
      role,
      text: textOut,
      toolAnchors: [],
      ...(cwd ? { cwd } : {}),
      timestamp: asString(obj.timestamp),
    });
  }
  return entries;
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

`ingestFile` (`ingest.ts:190`) calls `parseLine(line)` per line and groups by `entry.sessionId`. Codex's parser is whole-file + stateful, so we cannot keep the per-line `parseLine` for Codex. Introduce a **format dispatch** keyed by the transcript path: a Codex path (`/.codex/sessions/` or filename `rollout-…`) parses the whole text up front into entries, then the existing per-entry write/seed loop runs over them. Claude's path is **byte-for-byte unchanged** (still streamed line-by-line via `parseLine`).

Minimal, regression-safe approach: add a `parseTranscriptFile(absPath, text) → ParsedEntry[]` selector used **only** for Codex; keep Claude on the streaming `parseLine` path. Since `ingestSingleSession` already receives the absolute `transcriptPath`, the selector decides by path.

- [ ] **Step 1: Write the failing test** — feed a Codex fixture through `ingestSingleSession` against a temp store and assert observations land grouped under one session:

```typescript
// add to src/ingest/ingest.test.ts
it('ingests a Codex rollout transcript: one session, prose observations (#67)', async () => {
  const memory = await openTempMemory(); // existing test helper pattern
  const src = join(__dirname, '__fixtures__/codex/rollout-sample.jsonl');
  // Place under a codex-shaped path so the selector picks the Codex parser.
  const codexPath = join(tmpDir, '.codex/sessions/2026/05/14/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl');
  mkdirSync(dirname(codexPath), { recursive: true });
  copyFileSync(src, codexPath);
  const result = await ingestSingleSession(memory, codexPath);
  expect(result.observationsAdded).toBeGreaterThan(0);
  const sessions = memory.store.listSessions();
  expect(sessions.length).toBe(1);
});
```

- [ ] **Step 2: Run** → FAIL (Claude `parseLine` rejects every Codex line; 0 observations, 0 sessions).

- [ ] **Step 3: Wire the selector.** In `ingest.ts`:

```typescript
import { codexParseTranscript } from './codex-jsonl.js';

/** True when the path is a Codex rollout transcript. */
function isCodexTranscript(absPath: string): boolean {
  return absPath.includes('/.codex/sessions/') || /\/rollout-[\dT-]+-[0-9a-f-]{36}\.jsonl$/i.test(absPath);
}
```

In `ingestFile`, branch once at the top: for a Codex path, `readFileSync` the slice from `startOffset` and run `codexParseTranscript`, then iterate entries through the **same** `resolveSession`/`indexer.write`/`seedAnchors` body the Claude loop uses (extract that body into a small `writeEntry(memory, entry, project, …)` helper so both paths share it and there is no logic drift). For the Claude path, keep the existing `for await (const line of rl)` streaming loop verbatim. Advance the cursor to file size for the Codex path (whole-file parse; the cursor still gives "skip unchanged files" incrementality at the file granularity, which is all `ingestSingleSession` needs — a Codex rollout grows append-only like Claude's, and re-parsing from offset 0 each grow is acceptable for single-session ingest; if byte-precise resume is wanted later, that's a follow-on).

> Honesty note on Codex incrementality: the Claude path resumes mid-file by byte offset; the Codex whole-file parse re-reads from the cursor `start` each run. Because `session_meta` (carrying the id) is at the FILE HEAD, a `start > 0` slice would miss it — so for Codex we always parse from offset 0 and rely on the filename-UUID fallback ONLY if a future change streams. **Decision: for Codex, read from offset 0 (not the cursor) so `session_meta` is always seen, then write the cursor to EOF.** Re-ingesting an unchanged file is still skipped by the `cursor >= size` guard in `ingestOneTranscript` (`ingest.ts:289`), so a grown file re-parses fully but already-written observations are tolerated (the existing at-least-once contract). This is correct for single-session capture; document it.

- [ ] **Step 4: Run** `npm run check` (full suite — the regression gate). Claude ingest tests MUST stay green (the selector only diverts Codex paths). The new Codex test passes.

- [ ] **Step 5: Commit**
```bash
git add src/ingest/ingest.ts src/ingest/ingest.test.ts
git commit -m "feat(ingest): per-format parser seam — route Codex rollouts to the Codex parser (#67)"
```

---

## Task 6: W1 — per-harness `external_id` namespacing (migration-safe)

**Files:** Modify `src/store/memory-store.ts`, `src/ingest/session-binding.ts`, `src/ingest/ingest.ts` · Test `src/ingest/namespacing.test.ts`

**The collision:** `getSessionByExternalId(externalId)` and the `session-project:<externalId>` binding both key by the raw harness session id. With two harnesses on one DB, a Codex `session_meta.id` and a Claude `sessionId` could (theoretically) collide and merge into one store session, mixing two harnesses' transcripts. The design doc (line 117) mandates namespacing the id by source.

**Chosen approach — namespace at the ingest boundary, NOT in the store:** prefix the externalId with the harness id when it enters the store, e.g. `codex:019e2658-…`. The store stays harness-agnostic (it just sees a different opaque string); the binding key composes naturally (`session-project:codex:019e2658-…`).

**Migration safety (the hard requirement):** every EXISTING Claude session row was written with a RAW (un-prefixed) externalId. Prefixing Claude's ids going forward would orphan all existing rows + bindings. Two ways to stay safe; pick the **leave-Claude-bare** option:

- **Claude keeps bare ids** (no prefix) — its existing rows resolve unchanged, zero migration.
- **Codex (and every future harness) gets a `<harnessId>:` prefix.** Codex is brand-new, so there are no pre-existing bare Codex rows to migrate.

This makes namespacing **additive**: Claude is the un-prefixed "default namespace"; new harnesses are explicitly namespaced. Collision is now impossible (a Codex id is always `codex:…`, never bare). Implement as a pure helper so it is unit-testable and the rule lives in one place:

```typescript
// src/ingest/session-binding.ts (or a small src/ingest/namespacing.ts — keep it next to the binding)
/**
 * Namespace a harness session id for storage (W1, #67). Claude Code keeps its
 * BARE id (migration-safe: existing rows + bindings written before namespacing
 * resolve unchanged). Every other harness is prefixed `<harnessId>:` so two
 * harnesses' colliding raw ids never merge into one store session.
 */
export function namespacedExternalId(harnessId: string, rawSessionId: string): string {
  return harnessId === 'claude-code' ? rawSessionId : `${harnessId}:${rawSessionId}`;
}
```

**Where it's applied:** `ingestSingleSession` knows the transcript path → knows the harness. Thread the harness id into ingest. Cleanest seam: `ingestSingleSession(memory, transcriptPath, harnessId?)` — default `'claude-code'` (regression). The Codex adapter's `TranscriptSource` call passes `'codex'`. Inside `ingestFile`, when grouping, call `namespacedExternalId(harnessId, entry.sessionId)` before `resolveSession`/binding lookup. The binding writer (`writeBinding`) and `set_session_project` MCP/CLI path must namespace identically — but those are keyed by the CURRENT session's harness; for now they remain Claude-only callers (`set-session-project` is invoked from Claude flows), so passing the default keeps them correct. Document that a future Codex `set-session-project` must namespace too.

- [ ] **Step 1: Write the failing test:**

```typescript
// src/ingest/namespacing.test.ts
import { describe, expect, it } from 'vitest';
import { namespacedExternalId } from './session-binding.js';

describe('namespacedExternalId (W1)', () => {
  it('leaves Claude Code ids bare (migration-safe)', () => {
    expect(namespacedExternalId('claude-code', 'abc-123')).toBe('abc-123');
  });
  it('prefixes non-Claude harnesses', () => {
    expect(namespacedExternalId('codex', '019e2658')).toBe('codex:019e2658');
  });
});

describe('two harnesses, same raw id → distinct store sessions (integration)', () => {
  it('a Claude session and a Codex session with the SAME raw id do not merge', async () => {
    const memory = await openTempMemory();
    // Claude transcript with sessionId "DUPE" → stored bare as "DUPE".
    // Codex rollout with session_meta.id "DUPE" → stored as "codex:DUPE".
    // (Build both fixtures with the literal id "DUPE".)
    await ingestSingleSession(memory, claudeDupePath);           // default harness
    await ingestSingleSession(memory, codexDupePath, 'codex');
    const ids = memory.store.listSessions().map((s) => s.externalId).sort();
    expect(ids).toEqual(['DUPE', 'codex:DUPE']);
    expect(memory.store.listSessions().length).toBe(2);
  });
});
```

- [ ] **Step 2: Run** → FAIL (`namespacedExternalId` missing; both ingest into one session "DUPE").

- [ ] **Step 3: Implement** the helper + thread `harnessId` through `ingestSingleSession` → `ingestOneTranscript` → `ingestFile` → the grouping call. Apply `namespacedExternalId` immediately before `resolveSession` and before any `readBinding` lookup so the binding namespace matches. Claude's default keeps every existing test and row valid.

- [ ] **Step 4: Run** `npm run check` — full suite green (existing Claude session/binding tests prove migration safety: they pass un-prefixed ids and still resolve).

- [ ] **Step 5: Commit**
```bash
git add src/ingest/session-binding.ts src/ingest/ingest.ts src/ingest/namespacing.test.ts
git commit -m "feat(ingest): per-harness external_id namespacing — Claude bare, others prefixed (W1, #67)"
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

> The adapter's `install()`/`uninstall()` map cleanly onto the CLI's `cmdInstallHooks`/`cmdSetup`/`cmdUninstall`, which already iterate `resolveHarnesses(args)` and call `adapter.install()`/`adapter.registerMcp()`/`adapter.uninstall()` (`cli.ts:404,455,459`). No CLI change is needed beyond Task 8 making the adapter resolvable by id. `cmdUninstall` calls `unregisterMcpServer(spawnCapture)` directly with the Claude default — a follow-on should route uninstall MCP through the adapter so `--harness codex` unregisters from Codex; for THIS issue, `abs uninstall --harness codex` removes Codex hooks (via the adapter) but the direct `unregisterMcpServer` still targets `claude`. **Decision: thread the binary into `cmdUninstall`'s MCP unregister too** — small add: resolve the harness, and if it's codex pass `{ binary: 'codex' }` (the generalized `unregisterMcpServer` from Task 1 already supports it). Add this in Task 8 alongside registry wiring.

- [ ] **Step 4: Run** `npx vitest run src/harness/adapters/codex.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/harness/adapters/codex.ts src/harness/adapters/codex.test.ts
git commit -m "feat(harness): Codex CLI adapter — composes capabilities, payload-only session id (#67)"
```

---

## Task 8: Register Codex in `defaultRegistry()` + wire uninstall binary

**Files:** Modify `src/harness/index.ts`, `src/cli/cli.ts` · Test `src/harness/index.test.ts`, `src/cli/cli.test.ts`

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
```

- [ ] **Step 2: Run** → FAIL (`codex` not registered).

- [ ] **Step 3: Register + wire uninstall binary.** In `src/harness/index.ts`:

```typescript
import { codexAdapter } from './adapters/codex.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';
// …
if (!cached) cached = createRegistry([claudeCodeAdapter(), codexAdapter()]);
```

In `src/cli/cli.ts` `cmdUninstall` (~`:497`), when the resolved adapter is `codex`, pass `{ binary: 'codex' }` to `unregisterMcpServer` (Task 1 made it binary-aware). Keep the Claude default otherwise. Verify with the existing uninstall test path.

- [ ] **Step 4: Run** `npm run check` — full suite green.

- [ ] **Step 5: Commit**
```bash
git add src/harness/index.ts src/harness/index.test.ts src/cli/cli.ts src/cli/cli.test.ts
git commit -m "feat(harness): register Codex adapter in defaultRegistry + route uninstall to codex binary (#67)"
```

---

## Task 9: Acceptance — wire a real Codex install (manual verification)

**Files:** none (verification). Build first (`npm run build`) — `npm run check` does NOT rebuild `dist`, and the `abs` CLI runs from `dist`.

- [ ] **Step 1:** `npm run build`
- [ ] **Step 2:** `abs install-hooks --harness codex` → prints `registered hooks (Codex CLI): capture, recall, guard`. Inspect `~/.codex/config.toml`: a single managed block with `[[hooks.Stop]]`/`[[hooks.SessionStart]]`/`[[hooks.UserPromptSubmit]]`/`[[hooks.PreToolUse]]`, and a fresh `.bak` beside it. Re-run → no duplication, no new `.bak` from a no-op.
- [ ] **Step 3:** `abs setup --harness codex` → installs hooks AND prints the MCP registration result; confirm `codex mcp list` now lists `agentbrainsystem`, and `config.toml` gained a `[mcp_servers.agentbrainsystem]` table (written by `codex mcp add`, not by us).
- [ ] **Step 4:** Run a short real Codex session in a trusted project, then on `Stop` confirm `abs` captured it: `abs recall "<something you said>"` (or inspect the store) shows the Codex session's prose under the project's cwd. Confirm a new session opens with recalled context injected (recall on `SessionStart`/`UserPromptSubmit`).
- [ ] **Step 5:** `abs uninstall --harness codex` → removes the managed `[hooks]` block (other tables intact) and unregisters the MCP server from Codex (`codex mcp list` no longer lists it).
- [ ] **Step 6 (regression):** `abs install-hooks` (no flag) still wires Claude Code exactly as before; `~/.claude/settings.json` unaffected by any Codex work.

> If `Stop` does not fire capture in practice (e.g. the installed build gates `codex_hooks` behind project trust — the binary string `"Project-local config, hooks, and exec policies are disabled … until the project is trusted"` confirms hooks require a TRUSTED project), document it: the project must be trusted (`config.toml` `[projects."<cwd>"] trust_level = "trusted"`) for hooks to run. This is a Codex policy, not an `abs` bug; note it in the acceptance writeup and (follow-on) in `docs/agent-handbook.md`.

---

## Self-review checklist (run before declaring #67 done)

- [ ] `npm run check` fully green (lint + typecheck + all tests).
- [ ] Claude Code path is byte-identical: `abs install-hooks` / `abs setup` (no `--harness`) produce the same `settings.json` and the same `claude mcp add` argv as before (Task 1's regression test + the existing suite prove it).
- [ ] No core module imports `src/harness` (`git grep -n "from '.*harness" src/store src/recall src/embedding src/optimize` → only the W1 helper lives in `src/ingest`, which is allowed).
- [ ] The Codex parser is exercised by a REAL transcript fixture (not a synthetic one) — `src/ingest/__fixtures__/codex/rollout-sample.jsonl`.
- [ ] Namespacing is migration-safe: an existing bare Claude `external_id` still resolves (existing session/binding tests pass unchanged); a Codex id is always `codex:`-prefixed; the two-harness-same-raw-id test shows distinct sessions.
- [ ] `qualifies()` for Codex returns `{ ok: true, missing: [] }`; `resolveSession` is payload-only (no env leak).
- [ ] `Stop` (not `SessionEnd`) is the capture event in `eventMap` and in the TOML installer.

---

## Out of scope (tracked follow-ons, not this issue)

- **Codex tool-anchor extraction** — anchoring code edits from `apply_patch`/`function_call` lines (Codex shape ≠ Claude `tool_use`). Codex ships prose-only capture here; anchoring is a separate plan.
- **Byte-precise Codex incremental resume** — this issue re-parses the Codex rollout from offset 0 each grow (so `session_meta` is always read). Streaming with a head-cached session id is a perf follow-on.
- **Codex `set-session-project`** — namespacing the binding for a CURRENT Codex session (the `set_session_project` MCP/CLI path) when invoked from a Codex flow.
- **Auto-detect install** — `abs install-hooks`/`abs setup` with NO flag installing for ALL `detectInstalled()` harnesses (cross-adapter). The framework supports it (`detectInstalled()`); enabling it for both harnesses at once is a cross-cutting UX item.
