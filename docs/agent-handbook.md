# Agent Handbook

Shared onboarding layer for AI coding agents in this repository. Keep project facts here. Keep `AGENTS.md` and `CLAUDE.md` thin and agent-specific.

## Project Snapshot

- **Product:** local-first persistent memory system for AI coding agents — captures session history, stores it, and serves reliable semantic recall back to agents. Adds portable export/import and a visual graph UI.
- **Primary users:** solo developers running coding agents (Claude Code, Codex) who want durable cross-session memory; secondarily, the open-source community (public repo).
- **Current maturity:** MVP+ shipped (#1–#12, #14) on `main`: reliable `embed → persist → recall` over MCP, JSONL ingestion, portable export/import, the `abs` CLI, an interactive localhost graph UI, and optional LLM consolidation. Public repo.
- **Primary languages and frameworks:** **Node.js ≥22 + TypeScript (ESM)**; SQLite + sqlite-vec + FTS5 storage; transformers.js for local embeddings (pluggable to hosted); the official MCP SDK; esbuild + vanilla TS + force-graph for the UI. See `docs/adr/`.

## Read Order

1. `README.md`
2. `docs/engineering-workflow.md`
3. [GitHub Issues](https://github.com/victorbjuliani/agentbrainsystem/issues) — requirements and roadmap (source of truth)
4. `docs/adr/` (storage, UI pipeline, LLM consolidation) + `docs/DESIGN.md`
5. the nearest agent wrapper for the current tool (`CLAUDE.md` / `AGENTS.md`)

## Repository Map

| Path | Purpose | Notes |
| --- | --- | --- |
| `/` | repo root | thin wrappers + config live here |
| `docs/` | shared documentation | canonical onboarding/workflow/testing/docs-standards |
| `src/` | application code | TS source; tests colocated as `*.test.ts`. Layers: `config → store → embedding → indexer → recall → {mcp ⨁ ingest ⨁ export ⨁ ui} → memory.ts → cli` |
| `src/ui/` | localhost graph UI (#11) | `node:http` server (`server.ts`) + pure `buildGraph` projection (`graph.ts`) + shared wire contract (`graph-types.ts`); browser client in `src/ui/client/` (vanilla TS + force-graph, bundled by esbuild) |
| `src/llm/` | LLM chat provider (#12) | one generic OpenAI-compatible `/chat/completions` client (`client.ts`); covers local (Ollama/llama.cpp/LM Studio/vLLM) + hosted; reuses `embedding/retry.ts` |
| `src/consolidate/` | session → lessons (#12) | pure `distill.ts` (prompt + tolerant parse + zod schema) + `consolidate.ts` orchestrator; lessons written via the indexer (recallable), idempotent, opt-in |
| `scripts/build-ui.mjs` | UI bundler | esbuild: `src/ui/client` → `dist/ui/static/{app.js,app.css,fonts}` (self-hosted, offline) |
| `docs/adr/` | architecture decision records | committed; ADR 0001 = storage + embeddings; ADR 0002 = UI build pipeline & frontend stack; ADR 0003 = optional LLM consolidation |
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
- **Full gate (CI parity):** `npm run check` (lint → typecheck → test). `test` has a `pretest` hook that builds the UI bundle, so the gate is self-contained on a clean checkout.
- Run a TS entrypoint in dev: `npm run dev`
- Distill a session into lessons (opt-in, needs `ABS_LLM_BASE_URL`+`ABS_LLM_MODEL`): `abs consolidate [--session N] [--dry-run] [--force]`

## Architecture Notes

- **Runtime shape:** local daemon/CLI + MCP server + localhost web UI. Single-user, local-first.
- **Key components (shipped #1–#12):** session ingestion (JSONL) → embedding layer (local-default, pluggable, with hosted retry/backoff) → embedded vector + keyword store → recall API over MCP → optional LLM consolidation (session → lessons) → export/import → localhost graph UI.
- **State/data boundaries that are easy to break:** the index lifecycle (embedding → persistence → rebuild → recall). The reference tool we are replacing failed precisely here — indexing not invoked, indexes never persisted/rebuilt. Treat the **embed→persist→recall** path as the critical, test-first surface.

## Change Boundaries

- The memory store schema and the index lifecycle are the highest-risk areas — change with tests.
- The MCP tool contract is a public interface — version it deliberately.
- **LLM consolidation** (`src/consolidate/`) writes lessons ONLY through the indexer (recallability invariant), is opt-in/idempotent, and treats ingested transcripts as untrusted (output constrained to the lesson/decision schema). See ADR 0003.

## Open Questions (resolved during discovery)

- Final stack and storage engine (e.g. SQLite + a vector extension vs. alternatives).
- Default embedding model and dimensions; provider pluggability.
- Export/import format (portability artifact shape).
- ~~Graph UI rendering approach.~~ Resolved (#11): vanilla TS + `force-graph` (canvas 2D), bundled by esbuild, served read-only from a `node:http` localhost server — see `docs/adr/0002-ui-build-pipeline-and-frontend-stack.md` and `docs/DESIGN.md`.
- ~~LLM consolidation provider & shape.~~ Resolved (#12): one generic OpenAI-compatible chat client (local or hosted), opt-in via `ABS_LLM_*`, idempotent `abs consolidate` writing lessons through the indexer — see `docs/adr/0003-optional-llm-consolidation.md`.
