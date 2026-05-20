# AGENTS.md

Start here when Codex works in this repository.

Read before changing code:

1. `README.md`
2. `docs/agent-handbook.md`
3. `docs/engineering-workflow.md`
4. [GitHub Issues](https://github.com/victorbjuliani/agentbrainsystem/issues) — current requirements and roadmap (source of truth)

## Codex Notes

- Keep repo-specific knowledge in `docs/agent-handbook.md`, not duplicated here.
- Keep workflow rules in `docs/engineering-workflow.md`.
- `CLAUDE.md` is the Claude Code twin — keep shared instructions aligned across both wrappers.

## Repo Overrides

- Primary validation command: `[fill once the stack is finalized]`
- Main package manager / toolchain: `[fill once the stack is finalized — strong lean: Node/TypeScript]`
- Sensitive areas: the index lifecycle (`embed → persist → recall`) and the MCP tool contract. Change with tests.
