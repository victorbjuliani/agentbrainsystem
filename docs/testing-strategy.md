# Testing Strategy

> **Status:** baseline for a greenfield repo. Stack-specific commands are finalized at the first `/feature` (once Solution Shape picks the stack). Update this file then.

## Stack Family

**Agent / LLM system** with a backend core (memory store + MCP server) and a small web UI (graph visualization). Lean: Node.js / TypeScript.

## Suite Mix (intended)

| Suite | Scope | Priority |
| --- | --- | --- |
| **Unit** | embedding adapter, store schema, chunking, ranking math | high |
| **Integration** | the `embed → persist → recall` path end-to-end against a real (temp) store | **highest** |
| **Contract** | MCP tool inputs/outputs (recall, save, export, import) | high |
| **E2E / smoke** | ingest fixture transcript → recall returns it → export → re-import → recall still works | high |
| **UI** | graph UI (`abs ui`) — `buildGraph` projection unit tests, HTTP server contract tests (read-only/405/path-traversal/cap-clamp), boot smoke; canvas paint audited visually via `frontend-auditor`, not unit-tested | medium |
| **LLM consolidation** | `abs consolidate` — pure `distill` unit tests (prompt/parse/zod/injection-golden), orchestrator integration (idempotency, `--force` replace, dry-run-writes-nothing, batch rollback, default-latest, guards) against a temp store with an **injected stub `LlmProvider`**; the OpenAI-compat client tested via **mocked `fetch`** | high |

## Non-Negotiable Coverage

- The **`embed → persist → recall`** path must have an automated test that proves a saved item is retrievable by semantic query — including **across a restart** (persistence), not just in-memory. The tool we replace failed precisely because indexing was never persisted/rebuilt; a regression test guards this from day one.
- **Export → import round-trip** must be tested: export, wipe, import, recall returns the same content.

## Smoke Policy

- Every recall-affecting change runs the ingest→recall→restart→recall smoke before the PR leaves draft.

## Commands

- Full gate (CI parity): `npm run check` (lint → typecheck → test). Lint (Biome) and typecheck (`tsconfig.e2e.json`) cover `e2e/` too, so harness/scenario code is statically checked here without *running* the slow E2E suite.
- Test: `npm test` (watch: `npm run test:watch`); single area while iterating: `npx vitest run src/ui`
- Typecheck: `npm run typecheck` (runs `tsconfig.json`, the client `tsconfig.ui.json`, and `tsconfig.e2e.json`)
- Build (incl. UI bundle): `npm run build` → must produce `dist/ui/static/app.js`
- Packaging check: `npm pack --dry-run --json` → assert `dist/ui/static/app.js` ships (also enforced in CI)
- **End-to-end system suite (opt-in): `npm run test:e2e`** — see below. Kept OUT of `npm run check` (slow: builds, then spawns the real binary + a browser).

## End-to-End System Suite (`e2e/`, `npm run test:e2e`)

A real, full-system suite that drives the **built** binary (`dist/cli/cli.js`), the MCP
server over stdio, the lifecycle hooks, the optimize/delete write-paths, and the
localhost UI in a headless browser — the surfaces the module-level `*.test.ts` do not
exercise end to end. Run it before a release or after touching a cross-surface contract.

- **Command:** `npm run test:e2e` = `npm run build` → `vitest run -c vitest.e2e.config.ts` (scenarios A–H) → `playwright test -c playwright.config.ts` (UI scenarios I–J). One-time browser install: `npx playwright install chromium`.
- **Runners (disjoint globs, never overlap):** Vitest picks up `e2e/**/*.e2e.ts`; Playwright picks up `e2e/**/*.pw.ts`; the default `vitest.config.ts` (`src/**`) picks up neither.
- **Total isolation (the "leave no trace" contract):** every spawned `abs` process inherits a throwaway `HOME` + `ABS_HOME` from `e2e/harness.ts` → `makeHome()`. `ABS_HOME` isolates the store; `HOME` isolates the hooks' `settings.json` and optimize's auto-memory dir. Teardown is `rm -rf` of the temp home. The real `~/.agentbrainsystem` and `~/.claude` are **never** touched.
- **Offline / $0:** the embedding model cache lives in `node_modules/@huggingface/transformers/.cache` (not under `HOME`), so the temp-`HOME` override is safe and does not re-download. Offline is a consequence of the cache being warm — there is **no** env flag that enforces it (`@huggingface/transformers@4.x` ignores `TRANSFORMERS_OFFLINE`/`HF_HUB_OFFLINE`). The Vitest `globalSetup` (`e2e/global-setup.ts`) warms the cache once (the only step allowed to hit the network) and guards that `dist/` is built. The LLM path (consolidate) is exercised against a **fake localhost OpenAI-compatible server**, never a real endpoint.
- **Scenario matrix:** A ingest→status (isMeta turn dropped) · B persistence across a process restart · C export→import round-trip (replace/merge) · D MCP tool contract · E forget two-phase (single-use handle/replay) · F consolidate (dry-run/write/idempotent/`--force`) · G install-hooks + `abs hook` (snake_case payload, always exit 0) · H optimize preview→apply (CLAUDE.md + backup) + protected-memory guard · I UI graph + DOM-driven "excluir busca" delete · J UI write-path gates (CSRF/Origin 403, method 405, bad handle 409).
- **Determinism notes:** the canvas paint is audited visually via `frontend-auditor`, not asserted here; the UI delete uses the deterministic "excluir busca" buttons (waiting out the 250 ms search debounce), not a physics-positioned node click. Playwright artifacts land under `e2e/.tmp/` (gitignored).

> **UI test dependency:** the server/smoke tests read the bundled assets under `dist/ui/static/`.
> `npm test` runs a `pretest` hook (`npm run build:ui`) so `npm run check` is self-contained on a
> clean checkout; CI builds before testing as well.

> **No network LLM/embedder in CI:** consolidation tests inject a stub `LlmProvider` and the
> OpenAI-compat client is tested with a mocked `fetch` — never a real endpoint. The real LLM
> path is validated manually (`abs consolidate --dry-run` against a local Ollama) before
> release. The local embedding model downloads once (~one-time, slow) and runs offline after.

## Live Claude Code Smoke (`e2e/live/`, opt-in)

The highest-fidelity proof of the product's core promise: it drives a **real headless
Claude Code** (`claude -p`) end to end — Session A makes a decision → `SessionEnd` ingests it
→ a fresh Session B recalls it and the `UserPromptSubmit` hook injects it into the prompt →
the model uses it. Proves what the simulated-payload E2E (scenario G) cannot: that the loop
fires inside a genuine CC session.

- **What runs in `npm run check`:** the OFFLINE units only — `driver.test.ts` (stream-json
  parser, against a committed real-capture fixture) and `assert.test.ts` (injection gate +
  behavioral keyword-set). They never spawn `claude`. (`vitest.config.ts` includes
  `e2e/live/**/*.test.ts`.)
- **The live smoke is opt-in and OUT of CI:** `e2e/live/scenario.live.ts` self-skips unless
  `ABS_LIVE_CC=1` (it needs `claude` auth and spends tokens). Run it via
  **`./scripts/certify-1.0.sh`** (builds, then runs the full loop on `--model haiku`).
- **Two blocking gates:** (1) deterministic — the recalled-memory fence appears in the
  `UserPromptSubmit` `additionalContext` (parsed from `--output-format stream-json
  --include-hook-events`); (2) behavioral core — the answer used the recalled concept. The
  fuller behavioral set is a soft warning unless `ABS_LIVE_STRICT=1`.
- **Isolation differs from the system suite:** auth does **not** survive a fake `HOME`
  (`claude` reports "Not logged in"), so the live harness keeps the real `HOME` and isolates
  **only** the store (`ABS_HOME`) and hooks (a temp `--settings` pointing at the built
  binary). `--mcp-config '{"mcpServers":{}}' --strict-mcp-config` keeps it off the real MCP.
- **README GIF:** `scripts/make-readme-gif.sh` reuses the same harness to record the
  before/after demo (`docs/assets/certify-loop.gif` + a 9:16 `…-story.gif`). It captures the
  real runs once into `e2e/live/gif/cap/*.txt`, then vhs replays them deterministically, so
  `--no-capture` re-renders without spending tokens.
