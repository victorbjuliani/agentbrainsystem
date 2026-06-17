---
type: adr
title: ADR 0019 — Adopt the OKF house profile for docs and handoff artifacts
description: Adopt a pinned Open Knowledge Format profile as the house convention for docs/** frontmatter and process-handoff lineage.
status: active
timestamp: 2026-06-17T00:00:00-03:00
---

# ADR 0019 — Adopt the OKF house profile for docs and handoff artifacts

> **Status:** active — initial adoption.

## Context

Our docs (`docs/**/*.md`) and our process-handoff artifacts (feature/bug/discovery/session
handoffs) had no machine-readable identity. A reader — human or agent — could not reliably tell
what a file *is* (decision vs. handbook vs. discovery), when it last meaningfully changed, or how
artifacts relate across a workflow. We wanted:

- a small, stable frontmatter contract that an agent can trust;
- a lineage channel so handoff artifacts link to their predecessors (plan → implementation →
  tests → closure) and survive a cross-harness handoff (Claude Code ↔ Codex);
- a navigation surface (an index and a change log) that degrades gracefully when absent;
- ideally, an existing ecosystem so we are not inventing a bespoke schema nobody else reads.

## Decision

Adopt the **OKF house profile** as the canonical convention, defined authoritatively in the
`agent-docs` skill (`references/doc-system.md` → "OKF House Profile" + "OKF Handoff Contract").
This repo is the first pilot of that profile.

**Why OKF.** Open Knowledge Format (Google Cloud, `GoogleCloudPlatform/knowledge-catalog`) was
chosen because its data model already matched what we needed: a typed-corpus frontmatter, a
relations channel for lineage, and reserved navigation files (`index.md`, `log.md`) — and it
ships a viewer/graph, so the lineage we encode is visualizable without us building tooling. We
adopt the *data model*; we do not depend on its runtime.

**Pin, not label.** We pin to the `okf/SPEC.md` blob
`55d0a46cc988e99aa35cd027964d6278a4f93f35` (retrieved 2026-06-17), **not** the mutable label
"0.1". The label can move upstream; the blob SHA cannot. The house profile copies the rules it
needs so it survives upstream drift.

**Boundary, not coupling.** The house profile is the source of truth. OKF is *mapped-to at the
boundary* — we conform our frontmatter to it, but our concepts (abstract docs and process
artifacts) own the vocabulary. Notably `resource:` is intentionally unused (our concepts are not
URI-addressable resources).

## Scope of this pilot

- Frontmatter retrofit of **tracked** docs only: every `docs/adr/*.md` plus the root canonical
  docs (`agent-handbook`, `engineering-workflow`, `testing-strategy`, `documentation-standards`,
  `DESIGN`, `export-format`).
- Reserved files: root `docs/index.md` and `docs/log.md`.
- The per-project profile block in `docs/documentation-standards.md` (authored by `agent-docs`).
- **Gitignored doc dirs are skipped** (`docs/discovery/`, `docs/audits/`, `docs/superpowers/`) —
  they are not part of the tracked corpus.

## Consequences

- Every tracked doc now declares a non-empty `type`; agents can route by it.
- Conformance is **soft**: consumers tolerate missing optional fields, unknown `type`, broken
  links, and a missing `index.md`. `atualizar-docs` *warns*, never blocks.
- A future re-pin to a newer OKF blob is a **conscious version bump**, recorded by superseding
  this ADR — never a silent follow-along of the upstream label.

## Exit plan

If OKF stops serving us, the cost to leave is bounded: the house profile is already the source of
truth, so we drop the OKF mapping at the boundary and keep our frontmatter. The reserved files
and the `relations:` channel are plain markdown/YAML and remain useful standalone.

## References

- `agent-docs` skill → `references/doc-system.md` → "OKF House Profile" + "OKF Handoff Contract"
- Upstream pin: `GoogleCloudPlatform/knowledge-catalog` `okf/SPEC.md`
  @ `55d0a46cc988e99aa35cd027964d6278a4f93f35` (retrieved 2026-06-17)
- Per-project instance: [/docs/documentation-standards.md](/docs/documentation-standards.md)
