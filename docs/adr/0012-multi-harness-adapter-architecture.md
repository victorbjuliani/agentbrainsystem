# ADR 0012 — Multi-harness adapter architecture

**Status:** accepted · **Date:** 2026-05-23 · Epic: #65 · Adapters: #67 (Codex),
#68 (Gemini), #69 (Copilot), #72 (OpenCode) · Spikes: OpenCode parity (#70, ADR-0011) ·
Antigravity parity (#71, ADR-0013 — DOES-NOT-QUALIFY) · Depends on: ADR-0004 (hook model), ADR-0001 (storage)

## Context

agentbrainsystem began as a Claude Code-only memory layer (`capture → embed → persist →
recall`), wired through Claude's lifecycle hooks plus an MCP stdio tool surface. The core
(store / recall / embedding / optimize) had Claude's event names and config paths leaking
into it. Issue #65 set out to support more harnesses **without** that leakage and **without**
shipping half-integrations: a harness is "supported" only when it reaches full parity, the
same memory experience as Claude Code.

This ADR consolidates the architecture that the epic shipped across five adapters. The
per-harness mechanics and the parity verdict for the divergent OpenCode case were proven
empirically — see the OpenCode parity spike (#70, ADR-0011) and the per-harness plans under
`docs/superpowers/plans/` (`harness-codex`, `harness-gemini`, `harness-copilot`,
`harness-opencode`) plus the design spec `docs/superpowers/specs/2026-05-22-multi-harness-support-design.md`.

## Decision

### 1. The `HarnessAdapter` contract (`src/harness/types.ts`)

Every harness-aware concern lives behind one interface; the core never names a harness. The
contract's members:

- `id` / `displayName` — identity (`claude-code`, `codex`, `gemini`, `copilot`, `opencode`).
- `detect()` — is this harness installed on the machine? Never throws.
- `qualifies()` — the parity gate (below); returns `{ ok, missing[] }`.
- `eventMap` — the harness's **native** event names mapped onto the three **canonical
  moments** `capture` / `recall` / `guard`, so the installer is never hardcoded to one
  harness's event vocabulary.
- `install(cliPath)` / `uninstall()` — wire/unwire the lifecycle (idempotent, backup-first).
  `cliPath` (the installed CLI entrypoint) is threaded so a file-baked invocation can use an
  absolute `node <cli.js>` path; the four shell-hook adapters accept-and-ignore it.
- `registerMcp(cliPath, run)` — register the MCP stdio server. `run` is injected by the CLI
  (no harness→cli coupling).
- `resolveSession(input)` — resolve the session id (+ transcript path) for the current moment.
- `mcpBinary` / `mcpFileManaged` — routing flags read by `cmdUninstall` (which CLI owns
  `mcp add/remove`, or whether MCP is file-managed and the CLI path must be skipped).

`defaultRegistry()` (`src/harness/index.ts`) holds the five adapters; `resolveHarnesses()`
maps `--harness <id>` onto one (no flag → the Claude Code reference adapter). Adapters are
assembled from reusable `src/harness/capabilities/` (lifecycle installers, MCP registrars,
session resolvers, transcript sources), so a new harness composes existing pieces.

### 2. The parity policy (the `qualifies()` gate)

A harness ships **only when it delivers full parity** — all four pillars:

1. **Automatic capture** — a lifecycle trigger that fires when a turn/session settles.
2. **Automatic recall injection** — a mechanism to inject recalled context before the model
   answers.
3. **MCP stdio tools** — a registrable local stdio MCP server.
4. **Stable session id + readable transcript** — a durable id and a parseable per-message
   history the ingest path can read.

MCP-only harnesses (Cursor, Cline/Roo, Windsurf, Zed, Continue — no lifecycle hooks) are
**not** shipped; their parity is impossible today. `qualifies()` turns the product policy
into verifiable code: the CLI refuses a `--harness <id>` whose `qualifies().ok` is false
rather than installing a half-integration. All five shipped adapters return `{ ok: true }`.

### 3. The chokepoint namespace (`src/ingest/namespacing.ts`)

The store keys sessions + bindings by `external_id`. With multiple harnesses on one DB, two
harnesses' raw ids could collide and merge into one store session. `namespacedExternalId`
prefixes every harness EXCEPT Claude Code (`codex:`/`gemini:`/`copilot:`/`opencode:`); Claude
keeps its **bare** id, so every pre-existing row + binding resolves unchanged
(migration-safe). The namespace is applied **ONCE**, at the `dispatch.ts` chokepoint
(`harnessForPayload` derives the harness from the transcript-path shape), before any handler
sees the id. Capture-side ingest applies the same path-derived namespace. The core stays
harness-blind.

### 4. Per-harness event map, transcript model, and install surface

| Harness | Hook/wiring config | Capture event | Recall events | Guard event | Transcript model | MCP registration |
|---|---|---|---|---|---|---|
| **Claude Code** (reference) | `~/.claude/settings.json` (nested matcher groups) | `SessionEnd` | `SessionStart`, `UserPromptSubmit` | `PreToolUse` | JSONL, one obj/line, `<sessionId>.jsonl`; **byte cursor** | `claude mcp add … -- node <cli> start` (separator) |
| **Codex CLI** (#67) | `~/.codex/config.toml` managed `[hooks]` (TOML, sentinel) | `Stop` (no `SessionEnd`) | `SessionStart`, `UserPromptSubmit` | `PreToolUse` | JSONL rollout `~/.codex/sessions/**`; **byte cursor**; id from filename | `codex mcp add … -- …` (separator) |
| **Gemini CLI** (#68) | `~/.gemini/settings.json` (Claude shape, Gemini event names) | `SessionEnd` | `SessionStart`, `BeforeAgent` | `BeforeTool` | ONE whole JSON file rewritten per message; **id-anchored watermark** (no byte cursor; `/rewind`-safe) | `gemini mcp add` **positional** + `--scope user` (rejects `--`) |
| **GitHub Copilot CLI** (#69) | `~/.copilot/hooks.json` (FLAT JSON, `bash` key, SDK event names) | `sessionEnd` | `sessionStart`, `userPromptSubmitted` | `preToolUse` | `events.jsonl` in `~/.copilot/session-state/<uuid>/`; **byte cursor + compaction/fork re-sync guard**; id from parent-dir | `copilot mcp add … -- …` (separator, default) |
| **OpenCode** (#72) | in-process **plugin file** (no `abs hook`); shells `node <cli> opencode-capture/recall` | `session.idle`, `session.compacted` | `experimental.chat.system.transform` | `session.deleted` (in-plugin) | relational **SQLite** `~/.local/share/opencode/opencode.db` (read-only); **id-anchored part-id watermark** | **file-only** — `config.mcp.agentbrainsystem` written into JSONC config (`opencode mcp add` is an interactive wizard) |

Event names verified against: Claude Code; Codex (no `SessionEnd`, `Stop` is capture); Gemini
gemini-cli-core v0.35.0; Copilot SDK v1.0.51 (`userPromptSubmitted` — `userPromptSubmit` is
invalid and silently never fires); OpenCode plugin API v1.14.24 / runtime v1.15.10 (OpenCode parity spike #70, ADR-0011 via PR #79).

### 5. Architectural divergences worth recording

- **OpenCode is not a shell-hook harness.** It captures + recalls inside its own Bun process
  via a plugin module; history is relational SQLite, not a transcript file. So its adapter
  wires no `abs hook` commands — `install(cliPath)` writes a plugin file that shells the
  absolute `node <cli.js>`, and MCP is registered by editing the JSONC config (a plain-JSON
  config merges in place; a JSONC config aborts to a printed manual snippet, never clobbered).
- **At-least-once, never silent-drop** is the shared ingest-dedup tolerance for the watermark
  harnesses (Gemini/Copilot/OpenCode): a re-fired settle event re-reads only entries after the
  last-ingested id; if that id is gone (compaction/rewind) it re-syncs from the start. A
  duplicate observation is accepted; a drop is not.

## Consequences

- `abs install-hooks --harness <id>` / `abs setup --harness <id>` / `abs uninstall --harness
  <id>` wire any of the five; no flag targets Claude Code. `abs status` reports each harness's
  `installed` (`detect()`) + `parity` (`qualifies().ok`) so the user knows which id to run.
- Adding a harness is a contained change: a new `src/harness/adapters/<id>.ts` (reusing or
  adding a `capabilities/` piece), a registry entry, and a namespace clause — never a core edit.
- The four parity pillars are a hard gate; a non-qualifying harness is refused, not
  half-installed.

### Honestly deferred / not live-verified

These were proven by-design and unit/spike-tested, but full end-to-end runs were deferred for
lack of credentials/network and are tracked follow-ons — they are **not** claimed as
live-verified here:

- **Copilot `events.jsonl` ingest** — the finalized tool-anchor element schema needs an authed
  Copilot run (GitHub auth); an unrecognized shape degrades to `[]` rather than throwing.
- **OpenCode full-turn capture** — exercising a real `session.idle` end-to-end needs network
  for the live agent.
- **Gemini full e2e** — a complete capture→recall cycle needs an API key.
- **Tool-anchor extraction for non-Claude harnesses** is prose-only for now (Codex/Gemini/
  Copilot capture prose; code-anchor mining is a tracked follow-on).
