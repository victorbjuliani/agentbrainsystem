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

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
