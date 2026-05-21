# Agent Handbook

Shared onboarding layer for AI coding agents in this repository. Keep project facts here. Keep `AGENTS.md` and `CLAUDE.md` thin and agent-specific.

## Project Snapshot

- **Product:** local-first persistent memory system for AI coding agents — captures session history, stores it, and serves reliable semantic recall back to agents. Adds portable export/import and a visual graph UI.
- **Primary users:** solo developers running coding agents (Claude Code, Codex) who want durable cross-session memory; secondarily, the open-source community (public repo).
- **Current maturity:** MVP+ with a live memory layer, shipped on `main`. Foundation (#1–#12, #14): reliable `embed → persist → recall` over MCP, JSONL ingestion, portable export/import, the `abs` CLI, an interactive localhost graph UI, and optional LLM consolidation. Live memory layer (#15–#21): Claude Code hooks for hands-free auto-ingest + context injection (SessionStart baseline/staleness, per-prompt FTS-first), and an optimization loop that turns distilled memory into gated `CLAUDE.md` / auto-memory edits. Plus selective hard-delete across CLI, MCP, and the UI. Public repo.
- **Primary languages and frameworks:** **Node.js ≥22 + TypeScript (ESM)**; SQLite + sqlite-vec + FTS5 storage; transformers.js for local embeddings (pluggable to hosted); the official MCP SDK; esbuild + vanilla TS + force-graph for the UI. See `docs/adr/`.

## Read Order

1. `README.md`
2. `docs/engineering-workflow.md`
3. [GitHub Issues](https://github.com/victorbjuliani/agentbrainsystem/issues) — requirements and roadmap (source of truth)
4. `docs/adr/` (0001 storage · 0002 UI pipeline · 0003 LLM consolidation · 0004 hooks · 0005 per-prompt injection perf · 0006 gated-apply · 0007 UI write-path security · 0008 hard-delete) + `docs/DESIGN.md`
5. the nearest agent wrapper for the current tool (`CLAUDE.md` / `AGENTS.md`)

## Repository Map

| Path | Purpose | Notes |
| --- | --- | --- |
| `/` | repo root | thin wrappers + config live here |
| `docs/` | shared documentation | canonical onboarding/workflow/testing/docs-standards |
| `src/` | application code | TS source; tests colocated as `*.test.ts`. Layers: `config → store → embedding → indexer → recall → ground-truth → anchoring → {mcp ⨁ ingest ⨁ export ⨁ ui ⨁ consolidate ⨁ hooks ⨁ optimize ⨁ delete} → memory.ts → cli` |
| `src/ui/` | localhost graph UI (#11) + delete write-path (#20) | `node:http` server (`server.ts`) + pure `buildGraph` projection (`graph.ts`) + shared wire contract (`graph-types.ts`); browser client in `src/ui/client/` (vanilla TS + force-graph, bundled by esbuild). No longer read-only: two delete routes guarded by CSRF token + Host/Origin allowlist + handle confirmation (ADR 0007) |
| `src/llm/` | LLM chat provider (#12) | one generic OpenAI-compatible `/chat/completions` client (`client.ts`); covers local (Ollama/llama.cpp/LM Studio/vLLM) + hosted; reuses `embedding/retry.ts` |
| `src/consolidate/` | session → lessons (#12) | pure `distill.ts` (prompt + tolerant parse + zod schema) + `consolidate.ts` orchestrator; lessons written via the indexer (recallable), idempotent, opt-in |
| `src/hooks/` | Claude Code hooks (#15/#16/#19) | `abs hook <event>` handlers (session-end auto-ingest, session-start baseline + staleness cursor, user-prompt-submit FTS-first injection) + idempotent `install-hooks` settings.json writer; non-fatal/timeout-bounded (ADR 0004/0005) |
| `src/optimize/` | optimization loop (#18/#20/#21) | `run.ts` core: heuristic spine ($0) + optional LLM phrasing → evidence-backed candidate diffs; gated applier (backup/atomic/rollback, fail-closed `user\|feedback` guard) writes only `CLAUDE.md` + auto-memory (ADR 0006) |
| `src/delete/` | selective hard-delete (#delete) | sync `preview`/`execute` core: preview pins a concrete id set behind a single-use handle (TTL), execute deletes only the pinned set (TOCTOU-closed) + empty-session cleanup + `pruneIndexOrphans`; drives CLI/MCP/UI (ADR 0008) |
| `src/ground-truth/` | verifiable-memory port (#24) | `GroundTruthProvider` interface + code-review-graph adapter (read-only SQLite) + null adapter (graceful degradation); `git.ts` branch helper. Anti-corruption boundary for the graph (ADR 0009) |
| `src/anchoring/` | anchor verify + self-heal (#26/#28) | `sweepAnchors` promotes claimed→verified; `healAnchors`/`verifyOnRecall` re-anchor on rename, mark stale on removal (never delete). Fail-open (ADR 0009) |
| `scripts/build-ui.mjs` | UI bundler | esbuild: `src/ui/client` → `dist/ui/static/{app.js,app.css,fonts}` (self-hosted, offline) |
| `e2e/` | full-system E2E suite (opt-in) | `harness.ts` (isolated `HOME`/`ABS_HOME`, spawns the built binary + MCP stdio + UI + fake LLM) · `*.e2e.ts` (Vitest: CLI/MCP/optimize) · `*.pw.ts` (Playwright: UI) · `global-setup.ts` (cache warm-up + build guard). Run via `npm run test:e2e`; configs `vitest.e2e.config.ts` / `playwright.config.ts` / `tsconfig.e2e.json` |
| `docs/adr/` | architecture decision records | committed; 0001 storage+embeddings · 0002 UI build pipeline · 0003 LLM consolidation · 0004 hook model · 0005 per-prompt injection perf · 0006 gated-apply safety · 0007 UI write-path security · 0008 hard-delete safety · 0009 verifiable-memory anchoring |
| `docs/DESIGN.md` | visual identity | source-of-truth for the graph UI (palette, type, motion, graph language) |
| `.github/workflows/` | CI | `ci.yml` runs lint → typecheck → build → (pack assertion) → test |

Expand this table as the codebase materializes.

## Core Commands

Stack: **Node.js (≥22) + TypeScript (ESM)**, Biome (lint+format), Vitest (tests),
`tsc` (build/typecheck). See `docs/adr/0001-storage-and-embeddings.md` for the
storage/embedding decisions.

- Install: `npm install`
- Test: `npm test` (watch: `npm run test:watch`)
- Lint: `npm run lint` (autofix: `npm run lint:fix`)
- Typecheck: `npm run typecheck` (runs both `tsconfig.json` and the browser-client `tsconfig.ui.json`)
- Build: `npm run build` (`tsc` → `dist/`, then `build:ui` bundles the graph UI → `dist/ui/static/`)
- **Full gate (CI parity):** `npm run check` (lint → typecheck → test). `test` has a `pretest` hook that builds the UI bundle, so the gate is self-contained on a clean checkout. Lint + typecheck also cover `e2e/` (via `tsconfig.e2e.json`), but `check` does **not** run the slow E2E suite.
- **End-to-end system suite (opt-in):** `npm run test:e2e` — drives the built binary, MCP stdio, hooks, optimize/delete, and the UI (headless Playwright) against a throwaway `HOME`/`ABS_HOME`; self-cleaning, offline, real store untouched. One-time: `npx playwright install chromium`. Lives in `e2e/`; see `docs/testing-strategy.md` → "End-to-End System Suite".
- Run a TS entrypoint in dev: `npm run dev`
- Distill a session into lessons (opt-in, needs `ABS_LLM_BASE_URL`+`ABS_LLM_MODEL`): `abs consolidate [--session N] [--dry-run] [--force]`
- Register the Claude Code memory hooks (auto-ingest + context injection; opt-in, idempotent, backup-first): `abs install-hooks`. The registered hooks call `abs hook <session-end|session-start|user-prompt-submit>` internally — non-fatal/timeout-bounded, never invoked by hand. See ADR 0004/0005.
- Turn distilled memory into gated `CLAUDE.md` / auto-memory edits (preview → approve → apply; never automatic): `abs optimize [--project PATH] [--limit N] [--apply] [--candidate ID] [--yes]`. See ADR 0006.
- Selectively hard-delete memories (IRREVERSIBLE, preview-only without `--apply`): `abs forget [--ids a,b,c | --session N | --project NAME | --null-project | --search "q" [--limit N]] [--apply] [--yes]`. Export first — no backup. See ADR 0008.
- MCP tools exposed to agents: `recall`, `remember`, `memory_status`, `optimize`/`apply` (gated edits), and `forget_preview`/`forget` (two-phase selective delete: preview mints a single-use handle, `forget` consumes it — IRREVERSIBLE; ADR 0008). The UI write path (delete) is gated by the localhost CSRF/Origin controls in ADR 0007.

## Architecture Notes

- **Runtime shape:** local daemon/CLI + MCP server + localhost web UI + Claude Code lifecycle hooks. Single-user, local-first.
- **Key components:** session ingestion (JSONL) → embedding layer (local-default, pluggable, with hosted retry/backoff) → embedded vector + keyword store → recall API over MCP → optional LLM consolidation (session → lessons) → export/import → localhost graph UI. **Live memory layer on top:** hooks auto-ingest each session and inject relevant memory back (SessionStart + per-prompt FTS-first, no cold-load); the optimization loop turns distilled memory into gated `CLAUDE.md`/auto-memory edits; selective hard-delete prunes by id/session/project/search across CLI/MCP/UI.
- **State/data boundaries that are easy to break:** the index lifecycle (embedding → persistence → rebuild → recall). The reference tool we are replacing failed precisely here — indexing not invoked, indexes never persisted/rebuilt. Treat the **embed→persist→recall** path as the critical, test-first surface.

## Change Boundaries

- The memory store schema and the index lifecycle are the highest-risk areas — change with tests.
- The MCP tool contract is a public interface — version it deliberately.
- **LLM consolidation** (`src/consolidate/`) writes lessons ONLY through the indexer (recallability invariant), is opt-in/idempotent, and treats ingested transcripts as untrusted (output constrained to the lesson/decision schema). See ADR 0003.
- **Hooks** (`src/hooks/`) must stay non-fatal + timeout-bounded — any failure exits 0 and never blocks a Claude Code session (ADR 0004). The per-prompt injection path must stay FTS-first (no embedding cold-load) within the ADR 0005 latency baseline.
- **Write-to-real-files paths are guarded and gated.** `src/optimize/` edits only `CLAUDE.md` + auto-memory with per-candidate approval + backup/atomic/rollback + a fail-closed `user|feedback` guard (ADR 0006). `src/delete/` is irreversible hard-delete behind preview→pinned-handle→execute (ADR 0008). The UI write-path adds CSRF token + Host/Origin allowlist + handle confirmation (ADR 0007). Change these with their dedicated tests; never make them automatic.
- **The verifiable-memory layer is fail-open and read-only against ground truth** (ADR 0009). The PreToolUse guard (`src/hooks/pre-tool-use.ts`) only reads `tool_input` (never executes it), point-queries the graph read-only, warns by default (`ABS_GUARD_MODE=block` opts into deny), and degrades to silent-allow with no graph. Self-healing marks anchors `stale`, never deletes. `fact_anchors` lives in the index lifecycle (`embed → persist → recall`) — change with migration tests.

## Open Questions (resolved during discovery)

- Final stack and storage engine (e.g. SQLite + a vector extension vs. alternatives).
- Default embedding model and dimensions; provider pluggability.
- Export/import format (portability artifact shape).
- ~~Graph UI rendering approach.~~ Resolved (#11): vanilla TS + `force-graph` (canvas 2D), bundled by esbuild, served read-only from a `node:http` localhost server — see `docs/adr/0002-ui-build-pipeline-and-frontend-stack.md` and `docs/DESIGN.md`.
- ~~LLM consolidation provider & shape.~~ Resolved (#12): one generic OpenAI-compatible chat client (local or hosted), opt-in via `ABS_LLM_*`, idempotent `abs consolidate` writing lessons through the indexer — see `docs/adr/0003-optional-llm-consolidation.md`.
