# Design — Multi-harness support (memory beyond Claude Code)

**Date:** 2026-05-22 · **Status:** draft (brainstorm) · **Builds on:** ADR-0004
(hook installer / fail-open discipline), the ingest pipeline (`src/ingest`), the
hook handlers (`src/hooks`), the MCP server (`src/mcp`), and `src/cli/setup.ts`
(`claude mcp add`).

## Problem

`abs` integrates with **Claude Code only**. The user runs **Codex, OpenCode and
Claude Code simultaneously on the same machine** and wants the memory to work
across as many harnesses as possible — explicitly Codex, OpenCode, Grok Build,
Antigravity CLI, plus any other parity-capable harness on the market (Gemini CLI,
Copilot CLI). Today three of the four integration layers are hardcoded to Claude
Code, so none of those harnesses gets memory.

The integration surface has four harness-coupled layers plus one portable one:

| Layer | What it does | Coupling today | Portability |
|---|---|---|---|
| 1. Capture (ingest) | Parse `~/.claude/projects/**/*.jsonl` → prose + code anchors | Claude Code JSONL schema (`src/ingest/claude-jsonl.ts`) | per-harness format |
| 2. Auto-recall + injection | Hooks (`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`SessionEnd`) write `~/.claude/settings.json`, inject via stdout | Claude Code event vocabulary + settings format | not all harnesses have hooks |
| 3. Session identity | `CLAUDE_CODE_SESSION_ID` env / transcript filename | env var specific to Claude Code | varies per harness |
| 4. MCP tools | 8 tools registered via `claude mcp add` | MCP is a standard; only the registration command is specific | already portable |
| 5. Concurrency | one store per machine | single-writer assumption | needs concurrent + per-source cursor |

## Decisions (from brainstorm)

1. **Target = full parity.** A harness counts as "supported" only when it delivers
   the complete Claude Code experience: automatic capture + automatic injected
   recall + MCP tools + a stable session id.
2. **Parity-only gate (no degraded tiers).** A harness enters the official list
   **if and only if** it reaches full parity. MCP-only harnesses are *not* shipped
   as half-integrations.
3. **Parity = any lifecycle mechanism.** The trigger may be a shell hook, a plugin
   event, or an IDE/CLI lifecycle event — as long as it (a) fires automatic
   capture + recall and (b) exposes `session_id` + a readable transcript. We do
   not require Claude-style shell hooks specifically.
4. **Empirical spike gates the undocumented.** Any harness whose parity is not
   documented (OpenCode, Grok Build, Antigravity CLI) must pass a validation spike
   on a real machine before it becomes an official adapter. The spike confirms:
   session-id source, transcript schema, and that the lifecycle trigger actually
   fires capture/recall.
5. **Architecture = adapter contract (A) with capability composition inside (B).**
   A public `HarnessAdapter` contract, implemented by reusable capability modules,
   with a single canonical `Observation`/`SessionRecord` shape keeping the core
   (`embed → persist → recall → optimize`) 100% harness-agnostic.
6. **Shared concurrent store.** All harnesses write to the same `memory.db`,
   scoped by cwd (the existing project model). Sessions from different harnesses in
   the same folder are *distinct sessions of the same project* — no cross-harness
   semantic dedupe. Concurrency handled by WAL + busy-retry; ingest cursor is
   **per harness source**.

## Architecture

### The canonical contract (the keystone)

The non-negotiable invariant: **no line of the core may mention a harness name, an
env var, or a harness file path.** All harness knowledge lives behind the
`HarnessAdapter` contract. Every adapter's job is to produce the same internal
`Observation`/`SessionRecord` shape the core already consumes.

```
┌──────────── HARNESS-AWARE (pluggable) ────────────┐    ┌──── HARNESS-AGNOSTIC (core, untouched) ────┐
│ HarnessAdapter (public contract)                   │    │  Observation[] → embed → persist           │
│  ├─ detect()      installed on this machine?       │    │                          (memory.db, WAL)  │
│  ├─ qualifies()   reaches FULL PARITY? (gate)      │ ─► │  recall ◄ query (cwd-scoped)               │
│  ├─ install()/uninstall()  wire lifecycle          │    │  optimize (distill)                        │
│  ├─ registerMcp()  register the 8 tools            │    └────────────────────────────────────────────┘
│  └─ (session/transcript/injection via CAPABILITIES)│
│                                                     │
│  Reusable capabilities (the "B" core):              │
│   • TranscriptSource   (e.g. JsonlTranscriptSource shared by Codex + others)
│   • LifecycleInstaller (event-map driven — see below)
│   • SessionResolver    (hook payload | env var | filename)
│   • ContextInjector    (stdout | injectSteps | instruction file | MCP prompt)
│   • McpRegistrar       (harness-specific registration command)
└─────────────────────────────────────────────────────┘
```

### Semantic lifecycle model (forced by the Antigravity CLI finding)

Harnesses do **not** share an event vocabulary. Antigravity CLI, for example, has
no `SessionStart`/`SessionEnd`/`UserPromptSubmit` — it has `PreToolUse`,
`PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. So `LifecycleInstaller`
is parametrized by a **map from the harness's native events to ~3 canonical
moments**, never hardcoded:

| Canonical moment | Claude Code | Codex | Antigravity CLI | Copilot CLI | Gemini CLI |
|---|---|---|---|---|---|
| **CapturePoint** (ingest) | `SessionEnd` | `SessionEnd` / `Stop` | `Stop` (`fullyIdle`) | `sessionEnd` | `SessionEnd` |
| **RecallPoint** (inject) | `SessionStart` + `UserPromptSubmit` | `SessionStart` / `UserPromptSubmit` | `PreInvocation` (idempotent, 1st invocation) | `sessionStart` / `userPromptSubmitted` | `SessionStart` / `BeforeAgent` |
| **GuardPoint** (anti-contradiction) | `PreToolUse Edit\|Write` | `PreToolUse` | `PreToolUse` (matcher) | `preToolUse` | `BeforeTool` |

The fragile case is recall on harnesses with no "once at session start" event
(Antigravity): the adapter injects on the *first* `PreInvocation` per
`conversationId`, tracked idempotently in our store. This is adapter-specific work
but documented as a known risk.

### Session identity — generalized

Today: `CLAUDE_CODE_SESSION_ID` (env var). Codex, Gemini, Copilot, Grok and
Antigravity **do not expose a session id by env var** — they deliver `session_id`
(or `conversationId`) **and** `transcript_path` in the **hook stdin payload**. So
the canonical `SessionResolver` reads from the **hook payload**, and the env var
becomes a Claude-Code-only specialization. Bonus: because the payload also carries
`transcript_path`, `TranscriptSource` no longer has to guess the transcript
location per harness — it receives it.

### Concurrency & shared store

- **WAL + busy-retry** on `memory.db` so 3 harnesses can write concurrently.
- **Ingest cursor per harness source** (`ingest_cursor:<harness>`), so each
  `TranscriptSource` advances independently and they never reprocess or race.
  (Relates to the known hazard that resetting the DB wipes ingest cursors — the
  cursor key must be namespaced per harness.)
- **Session id namespaced by source** to avoid cross-harness id collision.
  Implemented (#67) at a SINGLE chokepoint in `src/hooks/dispatch.ts`: right after
  `parseHookPayload`, `payload.sessionId` is namespaced once (`harnessForPayload` →
  `namespacedExternalId`). Every hook-path consumer — `session-start.ts`,
  `user-prompt-submit.ts`, `scope.ts`, AND `pre-tool-use.ts` — receives the
  already-namespaced id with zero per-site code (the guard hook is covered by the
  chokepoint for free, like any other handler). Claude stays bare (migration-safe);
  Codex is `codex:<uuid>`.
- **No cross-harness semantic dedupe**: distinct transcripts = distinct sessions.

### `qualifies()` — the parity gate as code

Each adapter declares, testably, whether its harness exposes the four pillars
(capture trigger, injected recall, MCP, session id). `abs install --harness X`
refuses with a clear message when `qualifies()` is false, instead of installing a
half-integration. This turns the product policy (decision 2) into verifiable code.

### Install / detect UX

- `abs install` auto-detects installed harnesses and wires the lifecycle only for
  those that pass `qualifies()`.
- `abs install --harness X` targets one.
- `abs status` shows which harnesses are wired and at what tier.

## Per-harness classification (research-backed, 2026-05-22)

| Harness | Verdict | Mechanism / notes |
|---|---|---|
| **Claude Code** | reference adapter (done) | the existing code, refactored behind the contract |
| **Codex CLI** | qualifies (documented) | MCP `[mcp_servers]` in `config.toml`; 10 Claude-style hooks; JSONL `~/.codex/sessions/**`; `AGENTS.md`; session id in hook payload (no env var) |
| **Gemini CLI** | qualifies (documented) | MCP (tools+prompts+resources); 9 hooks; JSONL in transition; `GEMINI.md`/`AGENTS.md` |
| **Copilot CLI** | qualifies (documented) | MCP `~/.copilot/mcp-config.json`; hooks (`sessionStart/End`, `userPromptSubmitted`, `preToolUse`); `events.jsonl` in `~/.copilot/session-state/`; `AGENTS.md` |
| **Antigravity CLI** (`agy`) | **spike required** (leaning yes) | MCP `~/.gemini/antigravity-cli/mcp_config.json`; hooks with *different* events (`Stop`/`PreInvocation`); JSONL `<ws>/.gemini/jetski/transcript.jsonl`; `conversationId` in payload; `GEMINI.md`+`AGENTS.md`. Schema per-message + first-invocation recall need empirical check |
| **OpenCode** | **spike required** | MCP in `opencode.json`; **plugin events** (not shell hooks); transcript JSON→**SQLite** in transition; `AGENTS.md` (inferred) |
| **Grok Build** | **design-ready, validation blocked by access** | Announces hooks + MCP + `AGENTS.md` out-of-the-box (likely Codex-shaped); transcript/session-id undocumented; SuperGrok-Heavy-only beta, not installed → spike cannot run yet |
| Cursor, Cline/Roo, Windsurf, Zed, Continue | **excluded** | MCP yes, **no lifecycle hooks** → parity impossible today |
| Aider | **excluded** | no native MCP, no hooks, markdown-only transcript |
| Amp | **excluded** | cloud-first; threads server-side, no local transcript path |

## Roadmap

**Phase 0 — Adapter refactor (no new harness).** Extract `HarnessAdapter` +
capabilities from the existing code; Claude Code becomes the reference adapter.
Generalize `SessionResolver` to read `session_id` + `transcript_path` from the
payload (env var = Claude specialization). Add WAL + per-harness cursor.
**Gate: all existing tests pass through the new contract** — proof the abstraction
did not leak.

**Phase 1 — Codex CLI (first real second adapter).** Highest confidence: full
docs, Claude-style hooks, user dogfoods it. Reuses `JsonlTranscriptSource` +
`AGENTS.md` injector. Proves the contract survives a genuinely different harness.

**Phase 2 — two parallel tracks:**
- **2a · low-risk fan-out (documented):** Gemini CLI, Copilot CLI — mostly event-map
  + config differences once the contract exists.
- **2b · spikes (novel mechanisms):** OpenCode (plugin events; transcript format on
  the installed version) and Antigravity CLI (`Stop`/`PreInvocation` remap;
  idempotent recall; real `transcript.jsonl` schema). Each spike outputs a
  qualify/no-qualify verdict; only passers become adapters.

**Phase 3 — Grok Build (design-ready, access-gated).** Adapter drafted from docs
behind a `qualifies()` gate that only closes when someone with SuperGrok Heavy
access confirms transcript + session id. Plus any harness that later ships hooks.

## Testing strategy

- Each adapter ships with **fixture transcripts** + installer tests + a
  `qualifies()` test.
- The **Claude Code adapter regression** (the existing suite) is the contract
  guard: if it still passes through the new contract, Phase 0 is safe.
- Spikes (Phase 2b) are throwaway validation scripts, not shipped tests; their
  output is captured in an ADR per harness.

## Risks & open questions

- **Antigravity recall fragility:** no "once at start" event → idempotent
  `PreInvocation` injection keyed by `conversationId`. Needs the store to track
  per-conversation injection state.
- **Transcript formats in transition:** Gemini (JSON→JSONL) and OpenCode
  (JSON→SQLite) need version-pinned parsers; pin to the version on the user's
  machine and document the assumption.
- **Capture on abrupt kill:** like Claude Code's `SessionEnd` not firing on hard
  kill, harness CapturePoints may miss abrupt termination. Mitigation is the same
  class as today (opt-in historical ingest catches what live capture missed).
- **Decomposition:** Phase 0 is the first implementation-plan unit; each harness
  adapter is a follow-on plan. This spec is the umbrella; `writing-plans` plans
  Phase 0 first.

## Non-goals

- Degraded/partial tiers for MCP-only harnesses.
- Cross-harness semantic dedupe.
- Shipping any adapter that has not passed `qualifies()` (Grok stays behind the
  gate until validated).
