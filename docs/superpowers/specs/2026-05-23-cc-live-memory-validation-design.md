# Live Claude Code memory-loop validation — 1.0 certification

**Date:** 2026-05-23
**Status:** Design (awaiting user review)
**Scope:** Claude Code only (multi-harness out of scope for 1.0 certification)

## Problem

The product's whole thesis is one loop: a **real coding session is captured**, the
store recalls what matters, and that memory is **injected into every later prompt** so
the agent stops forgetting. Today that loop is proven only at the *contract* layer — unit
tests on `handleUserPromptSubmit`, and an E2E (`e2e/cli.e2e.ts`) that runs the built
binary `abs hook user-prompt-submit` against a **simulated** Claude Code payload and
asserts `additionalContext` is emitted.

That proves the plumbing emits the right JSON. It does **not** prove that, inside a
**real Claude Code session**, the hook fires every prompt and the model actually receives
and uses the injected memory. Closing 1.0 requires proving the live loop end-to-end.

## Goal

Drive a **real** headless Claude Code process and prove the full loop:

> real session captures a decision → store → fresh session recalls it → injected per
> prompt → the model uses it.

Deliver three things:

1. A **committed, reproducible** real-CC smoke harness (opt-in; outside `npm run check`
   and CI because it needs auth and spends tokens).
2. A **certification run executed now**, with an evidence report (PASS/FAIL).
3. An **impactful split before/after GIF** for the README, recorded against the same
   seeded store.

## Non-goals (YAGNI)

- Multi-harness (Codex/Gemini/Copilot/OpenCode) live validation.
- Wiring the live suite into CI (stays opt-in/manual — auth + token cost).
- Driving/asserting the interactive TUI for the *proof* path (proof uses headless `-p`).
- Asserting the "without" panel is *wrong* (that would be flaky and unfair — see GIF
  honesty note).

## Isolation model — prove the product without polluting the machine or breaking auth

| Concern | Approach |
| --- | --- |
| Store | `ABS_HOME=<tmp>` → throwaway SQLite. Real `~/.agentbrainsystem` never touched. |
| Hooks | `claude -p --settings <tmp>/hooks.json` loads only the `abs` hooks, pointed at the **built** binary. Real `~/.claude/settings.json` never edited. |
| Auth | `HOME` is **not** overridden, so OAuth/keychain keep working. (This differs from `e2e/harness.ts`, which overrides HOME for full isolation; here auth forces a narrower isolation boundary — store + settings only.) |
| Sessions | Fixed `--session-id <uuid>` per session + `--no-session-persistence` where it doesn't break SessionEnd ingest. |
| Teardown | `rm -rf <tmp>`. |

The hook command in the isolated settings is the real `abs hook <event>`; since Claude
spawns hooks as child processes, they inherit `ABS_HOME` from the `claude` process env, so
all writes land in the throwaway store.

## Step 0 — feasibility spike — ✅ PASSED (2026-05-23)

Ran against the built binary with `claude` 2.1.150, `--model haiku`, isolated
`ABS_HOME` + `--settings`. **All load-bearing assumptions hold; no fallback needed.**

| Assumption | Result |
| --- | --- |
| `SessionEnd` fires on a clean `claude -p` exit → ingests | ✅ isolated store went to `sessions: 1, observations: 3` after the session. |
| `UserPromptSubmit` injects in `-p` | ✅ the `<recalled-memory>` fence + notice appeared. |
| Hook events surface in `--output-format stream-json --include-hook-events` | ✅ `type:"system", subtype:"hook_response", hook_event:"UserPromptSubmit"` carries the `additionalContext` verbatim. |
| Full loop (Session A capture → store → Session B recall+inject) | ✅ Session A's "integer cents, never floats" decision was injected into Session B's prompt. |
| Model *uses* the injected memory | ✅ Session B answered "Use integer cents, consistent with your existing pattern … never floats … rounding errors in production." |
| Auth survives an isolated `HOME` | ❌ `Not logged in` — confirms the isolation model: keep `HOME`, isolate only `ABS_HOME` + `--settings`. |

**Proven invocation (the harness is built on exactly this):**

```bash
# isolated settings.json points hooks at the BUILT binary:
#   "command": "node <repo>/dist/cli/cli.js hook <event>"
# Session A (capture): SessionEnd ingests on clean exit
( cd "$PROJ" && ABS_HOME=$STORE claude -p "<prompt that commits a decision>" \
    --model haiku --settings "$SETTINGS" \
    --mcp-config '{"mcpServers":{}}' --strict-mcp-config )

# Session B (recall + injection, deterministic proof via stream-json):
( cd "$PROJ" && ABS_HOME=$STORE claude -p "<question depending on the decision>" \
    --model haiku --settings "$SETTINGS" \
    --mcp-config '{"mcpServers":{}}' --strict-mcp-config \
    --output-format stream-json --include-hook-events --verbose )
```

Notes baked into the plan:
- `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` keeps the run from touching the
  real MCP servers / real store.
- `--settings` **merges** onto the user's real settings, so the user's own (possibly
  broken) `abs` hook may also fire — harmless because `ABS_HOME` isolates the store and our
  isolated hook points at the working built binary.
- The spike recalled the *user* turn that stated the decision. The plan's Session A prompt
  must drive the **assistant** to articulate and commit the decisions in its reply, so the
  captured assistant turns carry them and recall feels organic (not a pre-stated user line).

## Scenario — a realistic payments API (the seeded project)

A small, real TypeScript checkout API lives under `e2e/live/fixture-project/` (real files:
`order.ts`, `money.ts`, a README). It is intentionally small but authentic — money
handling, a token, a couple of endpoints.

### Session A — capture (a genuine dev moment)

A real `claude -p` session works in the fixture project and, in the natural flow of the
task, lands two concrete, verifiable decisions:

- **Money is stored as integer cents — never floats.** Rationale tied to a real failure
  ("a float rounding bug bit us, so amounts are integer cents end-to-end").
- **The session token lives in an `httpOnly` cookie — never `localStorage`.** Rationale:
  XSS exposure.

On a clean exit, `SessionEnd` → `abs hook session-end` ingests the transcript into the
isolated store (or the Step-0 fallback runs).

### Capture gate

Assert via the built CLI / MCP (`abs recall` / `memory_status`) that the isolated store
now contains observations carrying the cents + httpOnly decisions. A failure here fails the
certification — there is no point proving recall over an empty store.

### Session B — recall + injection + use

A **new** `claude -p` session, same isolated store, run with
`--output-format stream-json --include-hook-events`. The prompt is a natural follow-up task
whose correct answer depends on Session A's decisions, e.g.:

> "I'm adding a refund endpoint to this API. How should I represent the refund amount, and
> where should the auth token go?"

- **Deterministic proof (injection) — the gate.** Parse the stream-json: the
  `UserPromptSubmit` hook event fired, and the emitted `additionalContext` contains the
  recalled decisions inside the `<recalled-memory>` fence. This is what blocks PASS/FAIL.
- **Behavioral proof (use) — corroborating.** The model's final answer reflects the
  decisions (keyword-set match: `cents`/`integer` for money, `httpOnly`/`cookie` for the
  token — tolerant of phrasing, never exact-string). Behavioral failure is reported as a
  warning that downgrades the verdict, configurable to block; injection failure always
  blocks.

## Components (isolated units)

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `e2e/live/driver.ts` | The only unit that knows the `claude` CLI: builds args, sets `ABS_HOME` + isolated `--settings`, spawns, parses `stream-json` into typed events (`hook`, `assistant`, `result`). | `node:child_process` |
| `e2e/live/seed.ts` | Materializes the fixture project + the deterministic Session A / Session B prompts into a temp dir. | fixture-project files |
| `e2e/live/assert.ts` | Pure assertions over parsed events + a store-recall snapshot (injection gate + behavioral keyword-set). | — |
| `e2e/live/scenario.live.ts` | Orchestrates A → capture gate → B, runs assertions. Opt-in via `ABS_LIVE_CC=1`; skipped otherwise so `npm run check`/CI never invoke it. | the three above |
| `scripts/certify-1.0.sh` | Runs the scenario, writes raw evidence (stream-json + recall dump) to `artifacts/certify-1.0/`, prints PASS/FAIL. | the binary + scenario |
| `e2e/live/*.tape` (vhs) | Records the two GIF panels (with / without abs) against the seeded store. | `vhs` |
| `scripts/make-readme-gif.sh` | Composes the two recordings into the split before/after GIF via `ffmpeg` (hstack + labels + divider), themed to the brand palette, → `docs/assets/`. | `ffmpeg` |
| `docs/testing-strategy.md` | New "Live Claude Code Smoke" section: what it proves, cost, how to run, why it is opt-in. | — |

`driver.ts` is the single seam over the CC CLI; everything else is testable without
spawning `claude`.

## The README GIF — split before/after

Two panels, side by side, same question to a fresh Claude Code session over the **same
fixture project**:

- **Left — "WITHOUT agentbrainsystem":** hooks not installed (or empty store). The agent
  has no memory of the past decision; it answers generically and may contradict the
  codebase. This is **amnesia**, the product's stated pain ("your agent forgets everything
  between sessions").
- **Right — "WITH agentbrainsystem":** the `<recalled-memory>` block flashes in, and the
  agent answers correctly, citing the cents + httpOnly decisions from "days ago."

### Honesty constraints (non-negotiable)

- Both panels are **real** `claude` runs against the **same** fixture, same prompt. Nothing
  staged or hand-typed as a fake response.
- The "without" panel is **not asserted to be wrong** — it demonstrates absence of memory,
  not stupidity. If the base model happens to answer well by luck, the contrast still holds
  because the WITH panel shows the *recalled fence* — provenance the WITHOUT panel cannot
  have.
- The GIF is recorded against the **same seeded store** used by certification, so it is the
  certified product, not a separate mock.

### Aesthetic

Terminal themed to `docs/DESIGN.md`: background `#1A1825`/`#0A0810`, brand violet `#8B5CF6`
accent, mono font. vhs `Set` directives for theme/size; `ffmpeg` `hstack` with a violet
divider and two labels. Output `docs/assets/certify-loop.gif` (final name TBD with user);
referenced in README near the existing demo, or replacing it if stronger.

## Testing strategy for this work

- `driver.ts` stream-json parser: unit-tested against captured fixture stream-json (no
  live spawn) — runs in `npm run check`.
- `assert.ts`: pure unit tests for injection-gate + keyword-set logic — runs in
  `npm run check`.
- `scenario.live.ts`: the live smoke itself — opt-in (`ABS_LIVE_CC=1`), excluded from
  `check`/CI.
- The certification run is executed once now and its evidence committed under
  `artifacts/` (or attached to the report), not re-run in CI.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| `SessionEnd` may not fire under `-p` | Step-0 spike; `abs ingest --apply` fallback, documented. |
| Hook event may not surface in stream-json | Step-0 spike; hook debug-sink fallback for the deterministic proof. |
| Token cost / quota | Short sessions; `--model haiku` for both sessions unless the user wants the default model in the proof. |
| Behavioral non-determinism | Injection is the blocking gate; behavioral is keyword-set + corroborating only. |
| Auth under non-default env | `HOME` left intact; isolate only store + settings. |
| GIF composition fragility | vhs `.tape` + `ffmpeg` are scripted and re-runnable; raw recordings kept so the GIF can be recomposed without re-spending tokens. |

## Resolved decisions

- **Model:** `--model haiku` for the certification run and all GIF iteration (cheap, proves
  the loop identically); the **final** README GIF recording uses the **default model**
  (Opus/Sonnet) for maximum impact on the public asset.
- **GIF placement:** the split before/after **replaces** `docs/assets/demo.gif` as the
  primary demo at the top of the README (one demo, the strongest one). Keep the raw
  recordings so it can be recomposed without re-spending tokens.
