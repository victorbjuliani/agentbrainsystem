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

- Primary validation command: `[fill once the stack is finalized]`
- Main package manager / toolchain: `[fill once the stack is finalized — strong lean: Node/TypeScript]`
- Sensitive areas: the index lifecycle (`embed → persist → recall`) and the MCP tool contract. Change with tests.
