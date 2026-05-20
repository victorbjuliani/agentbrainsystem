# Agent Handbook

Shared onboarding layer for AI coding agents in this repository. Keep project facts here. Keep `AGENTS.md` and `CLAUDE.md` thin and agent-specific.

## Project Snapshot

- **Product:** local-first persistent memory system for AI coding agents — captures session history, stores it, and serves reliable semantic recall back to agents. Adds portable export/import and a visual graph UI.
- **Primary users:** solo developers running coding agents (Claude Code, Codex) who want durable cross-session memory; secondarily, the open-source community (public repo).
- **Current maturity:** greenfield / prototype. No product code yet — being scoped via `docs/discovery/`.
- **Primary languages and frameworks:** *to be finalized in discovery (Solution Shape).* Strong lean: **Node.js / TypeScript** (MCP SDK ecosystem, JS-native local embeddings via transformers.js, embedded vector store, web UI for graph visualization).

## Read Order

1. `README.md`
2. `docs/engineering-workflow.md`
3. [GitHub Issues](https://github.com/victorbjuliani/agentbrainsystem/issues) — requirements and roadmap (source of truth)
4. architecture / ADR / design docs (once they exist)
5. the nearest agent wrapper for the current tool (`CLAUDE.md` / `AGENTS.md`)

## Repository Map

| Path | Purpose | Notes |
| --- | --- | --- |
| `/` | repo root | thin wrappers + config live here |
| `docs/` | shared documentation | canonical onboarding/workflow/testing/docs-standards |
| `src/` | application code | TS source; tests colocated as `*.test.ts`. Layers: `config → store → embedding → indexer → recall → {mcp ⨁ ingest ⨁ export ⨁ ui} → memory.ts → cli` |
| `src/ui/` | localhost graph UI (#11) | `node:http` server (`server.ts`) + pure `buildGraph` projection (`graph.ts`) + shared wire contract (`graph-types.ts`); browser client in `src/ui/client/` (vanilla TS + force-graph, bundled by esbuild) |
| `scripts/build-ui.mjs` | UI bundler | esbuild: `src/ui/client` → `dist/ui/static/{app.js,app.css,fonts}` (self-hosted, offline) |
| `docs/adr/` | architecture decision records | committed; ADR 0001 = storage + embeddings; ADR 0002 = UI build pipeline & frontend stack |
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

## Architecture Notes (intended, pre-implementation)

- **Runtime shape:** local daemon/CLI + MCP server + localhost web UI. Single-user, local-first.
- **Key components (planned):** session ingestion (JSONL) → embedding layer (local-default, pluggable) → embedded vector + keyword store → recall API over MCP → optional LLM consolidation → export/import → graph UI.
- **State/data boundaries that are easy to break:** the index lifecycle (embedding → persistence → rebuild → recall). The reference tool we are replacing failed precisely here — indexing not invoked, indexes never persisted/rebuilt. Treat the **embed→persist→recall** path as the critical, test-first surface.

## Change Boundaries

- The memory store schema and the index lifecycle are the highest-risk areas — change with tests.
- The MCP tool contract is a public interface — version it deliberately.

## Open Questions (resolved during discovery)

- Final stack and storage engine (e.g. SQLite + a vector extension vs. alternatives).
- Default embedding model and dimensions; provider pluggability.
- Export/import format (portability artifact shape).
- ~~Graph UI rendering approach.~~ Resolved (#11): vanilla TS + `force-graph` (canvas 2D), bundled by esbuild, served read-only from a `node:http` localhost server — see `docs/adr/0002-ui-build-pipeline-and-frontend-stack.md` and `docs/DESIGN.md`.
