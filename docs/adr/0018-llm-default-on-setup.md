# ADR 0018 — LLM optimization as a default-ON, guided step in `abs setup`

**Status:** accepted · **Date:** 2026-06-17 · Closes: the "LLM is invisible/never-configured"
gap · Depends on: #12 (consolidation), #138/#148 (auto-distill cadence) · Extends:
**ADR 0003** (optional LLM consolidation), **ADR 0017** (auto-distill cadence + two-signal
staleness). Does NOT supersede either — the LLM stays optional and the cadence gate is
unchanged.

## Context

`abs` captures every session continuously but, without an LLM, distils almost nothing. On a
real install (ADR-0017, measured on the maintainer's live store): **~98% of the store stays
raw turns and only ~0.5% becomes durable lessons**. The LLM is what turns raw turns into
high-signal, recallable lessons — so recall over a no-LLM store is noisier than it needs to
be. Yet the LLM was effectively invisible: it was configured only by manually exporting
`ABS_LLM_*` env vars, with no onboarding prompt and only a quiet SessionStart nudge. Most
users never connected one, so they ran permanently in the degraded path without a clear
moment to opt in.

The product decision (Gate 0, APPROVE-WITH-CHANGES) was to **reposition** from "local-first,
LLM opt-in/never-required" to "**local-first by default; an optional LLM sharpens recall**" —
and to surface that as a guided, default-ON step during setup, with an explicit, warned
opt-out. The positioning is a durable decision, so it lives in an ADR (the repo routes
positioning through ADRs 0003/0017, which this extends).

## Decision

### A guided, TTY-gated LLM step appended to `abs setup`

After the existing (mechanical, non-interactive) MCP/hooks wiring, `abs setup` runs a guided
interview (`runLlmSetupStep`, `src/cli/setup.ts`):

1. **Explain** (PT/EN via `$LANG`) why an LLM matters + what skipping costs (the ADR-0017
   ~98% raw / ~0.5% durable numbers). A small typed string table (`src/cli/locale.ts`) —
   **no full i18n layer** (PT + EN, fallback EN).
2. **Prompt** `[1] local/Ollama` ($0, offline, no key) → `[2] hosted` (OpenAI-compatible,
   needs a key) → `[3] skip`. Lead with local — the cheapest, keyless path.
3. **ONE advisory reachability probe** (`probeLlm`): a tiny completion against a short-timeout
   (`PROBE_TIMEOUT_MS = 6000`) `LlmConfig` **built in-process from the typed answers** (NOT
   from `loadConfig()`/env — the user's `export`s are not in the running process yet). The
   probe **never throws** and **never blocks** — a failure only warns ("continue anyway /
   configure later").
4. **Print** the env snippet (the key inline only for hosted, terminal display only). Values
   are **quoted** so a base URL / model / key containing metacharacters (`$`, backtick, `;`,
   space, `&`, …) can't malform the line or inject commands when pasted. The snippet is
   **platform-aware** (abs targets Windows, ADR-0001): on `win32` it emits the PowerShell
   `$env:VAR = '...'` form (POSIX `export` is not a valid command there); elsewhere the POSIX
   `export VAR='...'` form (Codex/CodeRabbit review, PR #179).
5. **Persist** two non-secret `kv_meta` markers: `setup:llmChoice` (`'local'|'hosted'|
   'declined'`) + `setup:lastRunAt` (ISO).

### LOCKED constraints (design to these)

- **ENV-VAR-ONLY key — the API key is NEVER stored.** Not in the SQLite store, not in any
  file abs writes, not in `abs export`. Setup only PRINTS the `export` line. The only
  persisted state is the two non-secret markers above. (`abs export` never serialises
  `kv_meta` at all, so the key cannot leak through an export — asserted by a round-trip test.)
- **Advisory probe, never blocking.** Any probe outcome (ok, unreachable, timeout, bad
  config) ⇒ the step continues and `abs setup` exits 0.
- **Non-TTY / `--harness` → silent degraded, exit 0.** The interview requires **both
  `process.stdin.isTTY` AND `process.stdout.isTTY`** — stdin alone is insufficient, because
  with stdout redirected/teed (`abs setup > setup.log`) the hosted key snippet (printed to
  stdout) would otherwise leak into that file (Codex review, PR #179). Falsy on either, OR an
  explicit `--harness <id>` (a scripted, single-target invocation) ⇒ NO prompt; mark
  `setup:llmChoice='declined'` **only if unset** (never clobber a real prior choice); exit 0.
  CI/scripted setup is byte-identical except for that one marker write.
- **Prompt-abort safe (E12).** A rejected prompt (Ctrl-C / EOF / closed stdin) is caught and
  treated as `'declined'`, exit 0 — the step never lets a rejection escape to the top-level
  `main().catch`, which would otherwise flip the exit code to 1.
- **Re-run gated on the LIVE config, not the stored marker (Codex review, PR #179).** The
  interview is skipped only when an LLM is **actually live** (`loadConfig().llm !== undefined`)
  — then setup prints one "already configured" line. A remembered `local`/`hosted` choice
  whose `export`s were never applied does NOT count as configured: a TTY re-run re-offers the
  interview, so the SessionStart "run `abs setup`" nudge can't dead-end. (`declined`/unset on
  a TTY also re-offers.) The stored marker is telemetry + the non-interactive `declined`
  bookkeeping, never the skip signal.
- **PT/EN only** for the CLI copy; the in-session SessionStart nudge is agent-localized.

### Cadence is UNCHANGED — the 3-conjunct gate

Configuring an LLM here satisfies **only the first** conjunct of the auto-distill cadence
gate (`src/hooks/session-end.ts`):

```
due = cfg.llm !== undefined        // ← this step can satisfy this one
   && cfg.autoDistill              // ABS_AUTO_DISTILL not opted out
   && obsCount >= cfg.distillMinObs // the just-ended session is substantial (DISTILL_MIN_OBS, default 25)
```

This ADR does **not** change the cadence and makes **no** claim that "LLM configured ⇒ cadence
runs" — a fresh or small session still won't auto-distill. The cadence remains ADR-0017's.

### SessionStart nudge strengthened

The no-LLM branch of `renderBaseline` (`src/hooks/session-start.ts`) now states the cost
explicitly ("without an LLM, recall runs on raw turns and ~99% of your store stays
undistilled") and points at `abs setup` first (local Ollama is $0/offline), keeping the
`ABS_LLM_BASE_URL` + `abs consolidate` escape hatches. **Empty-store gating is unchanged**
(owner-confirmed, NOTE-3 / E10): `renderBaseline` still returns `''` at zero observations, so
a brand-new store shows no nudge until it has content.

## Consequences

- **README reframed** (4 touchpoints): "no API keys" → "no API keys **required**" + an
  "optional, skippable LLM step in `abs setup`" framing; the FAQ qualifies the "no network
  calls" claim (true by default; the opted-in LLM is the one optional outbound call, and a
  local Ollama stays on-machine).
- **Backward compatible / additive.** Existing non-interactive `abs setup` behaves
  identically except for the one-time `setup:llmChoice='declined'` marker. No schema change,
  no new table, no new runtime dependency (reuses `OpenAiCompatLlmProvider`, `readline`,
  `kv_meta`). Trivially reversible.
- **Testability.** The `SetupIo` seam makes every interactive branch deterministic in unit
  tests (scripted prompts, fake probe, fake env, `isTty` toggle) — no real TTY/network in CI.
  The secret-never-stored invariant + the `abs export` round-trip are guarded by tests.

## Accepted gap

No automated proof that a *real* TTY renders the prompt correctly — covered by manual smoke
plus the deterministic seam tests.
