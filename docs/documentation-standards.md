# Documentation Standards

> **Status:** baseline for a greenfield repo. Expand as surfaces materialize.

## Canonical Documents

| Surface | File | When it must change |
| --- | --- | --- |
| Onboarding (humans + agents) | `docs/agent-handbook.md` | when project shape, stack, or commands change |
| Workflow | `docs/engineering-workflow.md` | when process/branching/PR rules change |
| Testing | `docs/testing-strategy.md` | when suites, commands, or smoke policy change |
| This system | `docs/documentation-standards.md` | when canonical surfaces are added/retired |
| Discovery | `docs/discovery/*.md` | when requirements/roadmap evolve |
| Architecture decisions | `docs/adr/NNNN-*.md` | one ADR per significant decision (created with the decision) |
| Public usage | `README.md` | when setup, commands, or the value proposition change |
| Agent wrappers | `CLAUDE.md`, `AGENTS.md` | thin; only tool-specific overrides |

## Rules

- **Code-changing work updates relevant docs before completion** (enforced in `docs/engineering-workflow.md`).
- Shared knowledge lives in `docs/`, not duplicated across `CLAUDE.md` / `AGENTS.md`.
- The **MCP tool contract** and the **export/import format** are public interfaces — document and version them explicitly when they exist.
- Architecture decisions get an ADR (`docs/adr/`), especially: storage engine, embedding default, export format, graph-UI approach.
