# ADR 0014 — Live Claude Code validation: prove the memory loop against a real harness

**Status:** accepted · **Date:** 2026-05-23 · Closes: 1.0 certification gap · Ships in: PR #94

## Context

The product's core promise is one loop: a real coding session is captured
(`SessionEnd` → ingest), the store recalls what matters, and the `UserPromptSubmit` hook
injects it into **every later prompt** so the agent stops forgetting (ADR-0004/0005).

Until now that loop was proven only at the **contract layer**: unit tests on
`handleUserPromptSubmit`, and an E2E (`e2e/cli.e2e.ts`, scenario G) that runs the built
binary `abs hook user-prompt-submit` against a **simulated** Claude Code payload and asserts
`additionalContext` is emitted. That proves the plumbing emits the right JSON; it does not
prove that, inside a **real Claude Code session**, the hook fires every prompt and the model
receives and uses the injected memory. Closing 1.0 requires proving the live loop.

## Decision

Add an **opt-in harness that drives a real headless Claude Code** (`claude -p`) end to end
(`e2e/live/`), and certify the full loop with it.

### Isolation model (the load-bearing constraint)

A spike established that **auth does not survive an isolated `HOME`** — `claude` reports
"Not logged in" when `HOME` is overridden, because OAuth/keychain is read from the real
home. This is the opposite of the system E2E suite (`e2e/harness.ts`), which overrides
`HOME` for total isolation. The live harness therefore:

- **keeps the real `HOME`** (so auth works), and
- isolates **only** the store (`ABS_HOME=<tmp>`) and the hooks (a temp `--settings` whose
  hooks point at the built `dist/cli/cli.js`), and
- runs with `--mcp-config '{"mcpServers":{}}' --strict-mcp-config` so it never touches the
  real MCP servers or the real `~/.agentbrainsystem` store.

`--settings` **merges** onto the user's real settings, so the user's own `abs` hook may also
fire — harmless because `ABS_HOME` isolates the store and our isolated hook points at the
working built binary.

### Proven mechanics (spike, verified against `claude` 2.1.150)

- `SessionEnd` **fires on a clean `claude -p` exit** → ingest runs (the isolated store goes
  from empty to populated).
- `UserPromptSubmit` **injects in `-p`**, and its event is observable in
  `--output-format stream-json --include-hook-events` as
  `type:"system", subtype:"hook_response", hook_event:"UserPromptSubmit"`, carrying the
  rendered `additionalContext` (the `<recalled-memory>` fence) verbatim.
- The full loop works: a decision made in Session A is injected into a fresh Session B and
  the model uses it.

### Test layering

- **Offline units in `npm run check`** (`e2e/live/*.test.ts`): `driver.ts` (stream-json
  parser, tested against a committed real-capture fixture) + `assert.ts` (injection gate +
  behavioral keyword-set). They never spawn `claude`.
- **Opt-in live smoke** (`e2e/live/scenario.live.ts`): self-skips unless `ABS_LIVE_CC=1`;
  excluded from CI because it needs auth and spends tokens. Two gates — (1) deterministic:
  the recalled-memory fence appears in the injection; (2) behavioral core: the answer used
  the recalled concept (fuller behavioral set is a soft warning unless `ABS_LIVE_STRICT=1`).
- **One-command certification:** `scripts/certify-1.0.sh`.

### README proof asset

`scripts/make-readme-gif.sh` reuses the harness to record a before/after demo
(`docs/assets/certify-loop.gif`, replacing `demo.gif`, + a 9:16 `…-story.gif`): the same
question to a fresh session over an **empty** store (amnesia) vs a **seeded** store (recall +
injection). Honesty constraints: both panels are real `claude` runs; the "without" panel is
not asserted to be wrong (it demonstrates absence of memory, not stupidity); the fixture
project is deliberately **neutral** (the decisions are not written in the code, so a
code-reading agent cannot infer them). Captured once into `e2e/live/gif/cap/*.txt`; vhs
replays deterministically so `--no-capture` re-renders without spending tokens.

## Consequences

- **Positive:** the 1.0 promise is provable on demand against a genuine Claude Code, not just
  a simulated payload. The harness is reproducible and the README demo is the certified
  product, not a mockup.
- **Scope:** Claude Code only — multi-harness live validation (Codex/Gemini/Copilot/OpenCode)
  is out of scope for 1.0 and not wired into CI.
- **Watch-outs:**
  - The live smoke depends on `claude` CLI flags (`-p`, `stream-json`,
    `--include-hook-events`, `--settings`, `--strict-mcp-config`); pin behavior with the
    offline parser fixture and re-capture if the CLI contract changes.
  - Stronger models honor the user's global `CLAUDE.md` over `--append-system-prompt`; the
    GIF capture pins output language with a temp project-local `CLAUDE.md` (not the committed
    fixture).
  - `SessionEnd` does **not** fire on an abrupt kill (only clean `-p` exit) — the certify
    path relies on a clean exit; an ingest fallback (`abs ingest --apply` on the
    transcript) remains the documented degradation if that ever changes.
