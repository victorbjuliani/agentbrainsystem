---
okf_version: "0.1"
---

# docs/ index

Progressive-disclosure map of the tracked documentation corpus. Grouped by subdirectory.
Pinned profile: see [/docs/documentation-standards.md](/docs/documentation-standards.md) → OKF House Profile.

> Gitignored doc trees (`docs/discovery/`, `docs/audits/`, `docs/superpowers/`) are working
> material, not part of the tracked corpus, and are intentionally not listed here.

## docs/ (root)

| Doc | Type | Description |
| --- | --- | --- |
| [agent-handbook.md](/docs/agent-handbook.md) | handbook | Repository map, commands, boundaries, validation expectations, gotchas. |
| [engineering-workflow.md](/docs/engineering-workflow.md) | engineering-workflow | Issue, branch, worktree, PR, review, and validation rules. |
| [testing-strategy.md](/docs/testing-strategy.md) | testing-strategy | Stack family, required suites, smoke policy, commands, fixtures. |
| [documentation-standards.md](/docs/documentation-standards.md) | documentation-standards | Doc taxonomy, source-of-truth rules, update triggers, OKF house profile. |
| [DESIGN.md](/docs/DESIGN.md) | design | Visual identity — palette, type, motion, creature anatomy. |
| [export-format.md](/docs/export-format.md) | export-format | The `abs-export` v1 portability artifact shape. |
| [log.md](/docs/log.md) | (reserved) | Chronological change history of the docs corpus. |

## docs/adr/ — architecture decisions

| ADR | Type | Description |
| --- | --- | --- |
| [0001-storage-and-embeddings.md](/docs/adr/0001-storage-and-embeddings.md) | adr | Storage engine and embedding provider. |
| [0002-ui-build-pipeline-and-frontend-stack.md](/docs/adr/0002-ui-build-pipeline-and-frontend-stack.md) | adr | UI build pipeline and frontend stack. |
| [0003-optional-llm-consolidation.md](/docs/adr/0003-optional-llm-consolidation.md) | adr | Optional LLM consolidation (session → lessons). |
| [0004-hook-integration-model.md](/docs/adr/0004-hook-integration-model.md) | adr | Hook integration model (Claude Code lifecycle hooks). |
| [0005-per-prompt-injection-performance.md](/docs/adr/0005-per-prompt-injection-performance.md) | adr | Per-prompt injection performance (FTS-first). |
| [0006-gated-apply-write-safety.md](/docs/adr/0006-gated-apply-write-safety.md) | adr | Gated apply: write safety for CLAUDE.md + auto-memory. |
| [0007-ui-write-path-security.md](/docs/adr/0007-ui-write-path-security.md) | adr | UI write path: security controls for selective hard-delete. |
| [0008-hard-delete-safety.md](/docs/adr/0008-hard-delete-safety.md) | adr | Selective hard-delete: safety for destructive memory removal. |
| [0009-verifiable-memory-anchoring.md](/docs/adr/0009-verifiable-memory-anchoring.md) | adr | Verifiable memory: code-grounded anchoring, self-healing, contradiction guard. |
| [0010-intentional-session-project-binding.md](/docs/adr/0010-intentional-session-project-binding.md) | adr | Intentional session→project binding (decision-aware ingest). |
| [0011-opencode-parity-spike.md](/docs/adr/0011-opencode-parity-spike.md) | adr | OpenCode parity spike. |
| [0012-multi-harness-adapter-architecture.md](/docs/adr/0012-multi-harness-adapter-architecture.md) | adr | Multi-harness adapter architecture. |
| [0013-antigravity-parity-spike.md](/docs/adr/0013-antigravity-parity-spike.md) | adr | Antigravity CLI (`agy`) memory-parity spike. |
| [0014-live-claude-code-validation.md](/docs/adr/0014-live-claude-code-validation.md) | adr | Live Claude Code validation of the memory loop. |
| [0015-creature-ui-shell-architecture.md](/docs/adr/0015-creature-ui-shell-architecture.md) | adr | Creature UI: renderer paradigm + tray shell architecture. |
| [0016-optimize-curation-gate.md](/docs/adr/0016-optimize-curation-gate.md) | adr | Optimize curation gate: drop trivia before promotion. |
| [0017-auto-distill-cadence.md](/docs/adr/0017-auto-distill-cadence.md) | adr | Auto-distill cadence: optimize by default, two-signal staleness. |
| [0018-llm-default-on-setup.md](/docs/adr/0018-llm-default-on-setup.md) | adr | LLM optimization as a default-ON, guided step in `abs setup`. |
| [0019-okf-house-profile.md](/docs/adr/0019-okf-house-profile.md) | adr | Adopt the OKF house profile for docs and handoff artifacts. |
