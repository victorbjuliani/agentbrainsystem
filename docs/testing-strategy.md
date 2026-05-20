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

## Non-Negotiable Coverage

- The **`embed → persist → recall`** path must have an automated test that proves a saved item is retrievable by semantic query — including **across a restart** (persistence), not just in-memory. The tool we replace failed precisely because indexing was never persisted/rebuilt; a regression test guards this from day one.
- **Export → import round-trip** must be tested: export, wipe, import, recall returns the same content.

## Smoke Policy

- Every recall-affecting change runs the ingest→recall→restart→recall smoke before the PR leaves draft.

## Commands

- Full gate (CI parity): `npm run check` (lint → typecheck → test)
- Test: `npm test` (watch: `npm run test:watch`); single area while iterating: `npx vitest run src/ui`
- Typecheck: `npm run typecheck` (runs both `tsconfig.json` and the client `tsconfig.ui.json`)
- Build (incl. UI bundle): `npm run build` → must produce `dist/ui/static/app.js`
- Packaging check: `npm pack --dry-run --json` → assert `dist/ui/static/app.js` ships (also enforced in CI)

> **UI test dependency:** the server/smoke tests read the bundled assets under `dist/ui/static/`.
> `npm test` runs a `pretest` hook (`npm run build:ui`) so `npm run check` is self-contained on a
> clean checkout; CI builds before testing as well.
