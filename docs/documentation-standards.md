---
type: documentation-standards
title: Documentation Standards
description: Doc taxonomy, source-of-truth rules, update triggers, OKF house profile.
timestamp: 2026-05-26T22:37:52-03:00
status: active
---

# Documentation Standards

> **Status:** baseline for a greenfield repo. Expand as surfaces materialize.

## Canonical Documents

| Surface | File | When it must change |
| --- | --- | --- |
| Onboarding (humans + agents) | `docs/agent-handbook.md` | when project shape, stack, or commands change |
| Workflow | `docs/engineering-workflow.md` | when process/branching/PR rules change |
| Testing | `docs/testing-strategy.md` | when suites, commands, or smoke policy change |
| This system | `docs/documentation-standards.md` | when canonical surfaces are added/retired |
| Visual identity | `docs/DESIGN.md` | when palette/type/motion/anatomy change |
| Export/import format | `docs/export-format.md` | when the portability artifact shape changes |
| Discovery | `docs/discovery/*.md` | when requirements/roadmap evolve |
| Architecture decisions | `docs/adr/NNNN-*.md` | one ADR per significant decision (created with the decision) |
| Public usage | `README.md` | when setup, commands, or the value proposition change |
| Agent wrappers | `CLAUDE.md`, `AGENTS.md` | thin; only tool-specific overrides |

## Rules

- **Code-changing work updates relevant docs before completion** (enforced in `docs/engineering-workflow.md`).
- Shared knowledge lives in `docs/`, not duplicated across `CLAUDE.md` / `AGENTS.md`.
- The **MCP tool contract** and the **export/import format** are public interfaces — document and version them explicitly when they exist.
- Architecture decisions get an ADR (`docs/adr/`), especially: storage engine, embedding default, export format, graph-UI approach.

## OKF House Profile

<!-- okf:begin -->
OKF profile pinned at SPEC.md@55d0a46. Corpus types in use here: handbook, engineering-workflow, testing-strategy, documentation-standards, design, adr, export-format.
Rules live in agent-docs doc-system → "OKF House Profile" — do not restate them here.
<!-- okf:end -->

Adoption rationale and pin provenance: [/docs/adr/0019-okf-house-profile.md](/docs/adr/0019-okf-house-profile.md).
