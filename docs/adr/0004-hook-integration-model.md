---
type: adr
title: ADR 0004 — Hook integration model (Claude Code lifecycle hooks)
description: Hook integration model built on Claude Code lifecycle hooks.
timestamp: 2026-05-20T22:02:55-03:00
status: accepted
---

# ADR 0004 — Hook integration model (Claude Code lifecycle hooks)

**Status:** accepted · **Date:** 2026-05-20 · Depends on: #7 (ingest), #6 (recall) · Implemented across: #15 (SessionEnd), #16 (SessionStart), #19 (UserPromptSubmit)

## Context

agentbrainsystem ingests Claude Code transcripts and recalls them. Until now ingest was
manual (`abs ingest`) and recall was MCP-only. The live-memory initiative makes the loop
**automatic** by wiring three Claude Code lifecycle hooks:

- **SessionEnd** → auto-ingest the just-finished session ($0, no LLM) — #15.
- **SessionStart** → inject a baseline context block + a "N optimizations pending" staleness
  flag ($0, no LLM) — #16.
- **UserPromptSubmit** → inject memory relevant to the prompt (FTS-first, per ADR-0005) — #19.

Hooks run on the user's interactive critical path. They must be fast, must never block or
break the session, and they mutate a shared, user-owned file (`~/.claude/settings.json`) that
other tools also write to. This ADR fixes the contracts that make that safe.

## Decision

### Events & payload contract

Claude Code spawns each registered hook as a `command` and pipes a JSON payload on **stdin**.
We consume a defensively-parsed subset (`src/hooks/payload.ts`): `session_id`,
`transcript_path`, `cwd`, `hook_event_name`; `prompt` (UserPromptSubmit) and `source`
(SessionStart). Parsing **never throws**: malformed/partial input degrades to an empty payload.
The payload is **untrusted input** (see Trust boundary).

### Context injection

SessionStart and UserPromptSubmit inject context by printing a single JSON line to **stdout**:

```json
{"hookSpecificOutput":{"hookEventName":"<Event>","additionalContext":"<text>"}}
```

(`buildContextOutput`). SessionEnd **cannot inject** — it just runs. stdout is reserved for
this protocol line; **all diagnostics go to stderr**, mirroring the CLI's `err()` discipline.

### Non-fatal / timeout model

Every handler runs behind `runHookSafely` (`src/hooks/runner.ts`):

- The handler is raced against a **self-bound timeout** (default 8 s) that is independent of —
  and tighter than — the `timeout` registered in settings.json (belt and braces).
- **ANY** thrown error or timeout is swallowed: a stderr diagnostic is written, **nothing** is
  written to stdout, and `process.exitCode` is forced to **0**. A handler can never leak a
  non-zero code that Claude Code would treat as a hook failure.
- An unknown event arg is a silent no-op (exit 0).

Net: a hook either injects exactly one valid line of context or does nothing — it can never
block, slow past its bound, or break the session.

### Who owns settings.json (backup + idempotent merge)

`abs install-hooks` (`src/hooks/installer.ts`) is the **only** code that mutates
`~/.claude/settings.json`. It is **opt-in** (nothing registers until the user runs it) and:

- **Single registry, keyed by event** (`HOOK_REGISTRY`). Adding SessionStart (#16) and
  UserPromptSubmit (#19) is one registry entry each — not three bespoke writers. The installer
  accepts an `events` subset so each issue can register incrementally.
- **Idempotent.** A hook is identified by its exact `command` string (`abs hook <event-arg>`).
  Re-running is a no-op for already-present hooks — no duplicates.
- **Backup-first.** Before any mutation, settings.json is copied to a timestamped `.bak` beside
  it, so a bad merge is recoverable.
- **Never clobbers.** The full settings object is read; only `hooks.<Event>` is touched; our
  entry is merged into the existing empty-matcher group (or a new group is appended) so other
  tools' hooks — and unrelated top-level keys — are preserved verbatim.
- **Refuses corrupt input.** A settings.json that is not valid JSON throws rather than being
  silently overwritten.

### CLI surface

- `abs install-hooks` — register the hooks (reports added vs already-present + backup path).
- `abs hook <event>` — internal entry the registered hooks invoke; dispatches by event arg
  (`session-end | session-start | user-prompt-submit`), reading the payload on stdin. Always
  exits 0.

## Trust boundary (security)

The hook payload — including `prompt` (UserPromptSubmit) and the transcript it triggers ingest
of (SessionEnd) — is **untrusted**. Two containments:

1. **Injection into the store** (SessionEnd → ingest) reuses the existing ingest path; the
   stored text is data, not executed. Consolidation (#12, opt-in) already fences transcript as
   DATA with schema-validated output, so an injected payload cannot escalate beyond a stored
   observation.
2. **Injection into the model context** (UserPromptSubmit/SessionStart `additionalContext`) is
   recalled store content surfaced back to the agent. It is the same trust level as the
   transcript that produced it — we add a clear provenance framing in the injected block
   (#16/#19) so the agent treats it as recalled memory, not instructions. The FTS-first path
   (ADR-0005) also avoids running any model at hook time.

## Consequences

- **Positive:** the ingest→recall loop becomes automatic and $0 by default; one installer
  serves all three (and future) hooks; settings.json mutation is backup-first, idempotent, and
  non-destructive; the non-fatal contract guarantees hooks never degrade the session.
- **Negative / trade-offs:** the installer writes a global user file (mitigated by backup +
  opt-in + idempotency). Per-prompt recall is lexical-only in the MVP (ADR-0005). SessionEnd
  loads the embedding model to index new turns (the documented embedding cost; still $0/local).
- **Untested by design:** the live Claude Code spawn (no harness in CI). Payload parsing,
  the runner contract (throw + timeout), session-end auto-ingest, dispatch routing, and the
  installer merge are all unit-tested with temp files / stubs.

## Alternatives rejected

- **Three bespoke settings writers (one per event).** Triplicates the dangerous merge logic;
  one registry-driven installer is safer and DRY.
- **Replacing `hooks.<Event>` wholesale.** Would clobber other tools' hooks. Rejected for an
  additive, group-aware merge.
- **Letting a hook exit non-zero on error.** Claude Code treats that as a hook failure and could
  surface noise or block; the non-fatal contract forces exit 0 instead.
- **Running recall/embedding inline on UserPromptSubmit (hybrid).** Cold model load per prompt;
  see ADR-0005 — FTS-first instead.
