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
| **UI** | graph rendering smoke (later, when the UI exists) | medium |

## Non-Negotiable Coverage

- The **`embed → persist → recall`** path must have an automated test that proves a saved item is retrievable by semantic query — including **across a restart** (persistence), not just in-memory. The tool we replace failed precisely because indexing was never persisted/rebuilt; a regression test guards this from day one.
- **Export → import round-trip** must be tested: export, wipe, import, recall returns the same content.

## Smoke Policy

- Every recall-affecting change runs the ingest→recall→restart→recall smoke before the PR leaves draft.

## Commands

- Test: `[tbd — fill at first /feature]`
- Coverage: `[tbd]`
