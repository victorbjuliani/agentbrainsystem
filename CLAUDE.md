# CLAUDE.md

Start here when Claude Code works in this repository.

Read before changing code:

1. `README.md`
2. `docs/agent-handbook.md`
3. `docs/engineering-workflow.md`
4. [GitHub Issues](https://github.com/victorbjuliani/agentbrainsystem/issues) — current requirements and roadmap (source of truth)

## Claude Code Notes

- Keep repo-specific knowledge in `docs/agent-handbook.md`, not duplicated here.
- Keep workflow rules in `docs/engineering-workflow.md`.
- `AGENTS.md` is the Codex twin — keep shared instructions aligned across both wrappers.

## Repo Overrides

- Primary validation command: `npm run check` (lint → typecheck → test); see `docs/agent-handbook.md` → Core Commands.
- Main package manager / toolchain: **npm + Node ≥22 + TypeScript (ESM)**; Biome (lint/format), Vitest (test), `tsc` (build). Storage/embedding decisions in `docs/adr/0001-storage-and-embeddings.md`.
- Sensitive areas: the index lifecycle (`embed → persist → recall`) and the MCP tool contract. Change with tests.
