---
type: engineering-workflow
title: Engineering Workflow
description: Issue, branch, worktree, PR, review, and validation rules.
timestamp: 2026-06-15T22:49:43-03:00
status: active
---

# Engineering Workflow

Default workflow baseline for this repository. Update this file when reality diverges, rather than forcing a process nobody follows.

## Source of Truth

When workflow docs disagree, use this order:

1. `README.md`
2. `CONTRIBUTING.md` (if present)
3. this file
4. issue and PR templates
5. agent wrappers (`CLAUDE.md`, `AGENTS.md`)

## Work Intake

- An issue precedes implementation. Discovery (`docs/discovery/`) produces the issue roadmap; each issue is delivered via the feature workflow.
- Problem statement, scope, and acceptance criteria are explicit on every issue.

## Branch and Commit Conventions

- **Branch naming:** `<type>/<issue-number>-<slug>` (e.g. `feat/12-mcp-recall`, `fix/30-index-persist`).
- **Worktrees:** create them inside `<repo-root>/.worktrees/`. Never sibling directories outside the project. `.worktrees/` is git-ignored.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Commit messages explain the user-visible or system-level change, not just the code motion.

## Worktrees

- Preferred location: `<repo-root>/.worktrees/`.
- This section is the source of truth for worktree placement for both Codex and Claude Code workflows.

## Pull Request Rules

- Open PRs in **draft** until scope and validation are ready.
- Link every PR to an issue.
- Keep PRs reviewable in one pass.
- Include validation notes, risks, and rollback considerations.
- Convert from draft only after scope is implemented and checks are green or explained.

## Review Expectations

- Call out areas needing reviewer focus.
- **Code-changing work must update relevant tests and relevant documentation before completion.**
- Escalate breaking changes, migrations, or data-shape changes explicitly. The memory store schema and the MCP tool contract are versioned interfaces.

## Validation Baseline

- Run the smallest reliable set of checks that proves the change works.
- The **embed → persist → recall** path is the project's critical surface — it must have automated coverage before a recall-related change is considered done (the tool we replace failed exactly here).
- If a check cannot run, say why and record the blocker in the PR.

## CI & Automated Gates

- **Branch protection (`main`):** PR-based merges only; required status checks **`check`** + **`e2e`**; 0 required approvals (solo); admin bypass on. Direct pushes to `main` are blocked for non-admins.
- **CI (`ci.yml`):** `check` (lint → typecheck → build → test) and `e2e` (headless system E2E) on every PR; `e2e-ui` (Playwright) on main pushes / nightly / manual dispatch.
- **PR review bots:** CodeRabbit (`.coderabbit.yaml`) + Codex (`chatgpt-codex-connector`) review every PR — resolve or reply to their threads before merge. (These are the *review* bots, distinct from the Codex *harness adapter* the product supports.)
- **Security scanning** (findings land in the Security tab):
  - **GitGuardian** — secret scanning (PR check).
  - **CodeQL** (`codeql.yml`) — JS/TS SAST on PRs, main, weekly.
  - **OpenSSF Scorecard** (`scorecard.yml`) — supply-chain posture, weekly + main; publishes the score.
  - **zizmor** (`zizmor.yml`) — GitHub Actions static analysis, audit mode (`continue-on-error`); config in `.github/zizmor.yml` (ignores `cache-poisoning` for `release.yml`, with rationale).
  - **Harden-Runner** — first step of every `ci.yml`/`release.yml` job, `egress-policy: audit`.
  - Private vulnerability reporting is enabled; reporting process in `SECURITY.md`.
- **Dependencies:** **Renovate** (`.github/renovate.json`) — weekly, grouped; GitHub Actions bumps auto-merge for **non-major only**; npm devDeps grouped; vulnerability alerts labelled.
- **GitHub Actions pinning:** every action is pinned to a commit SHA with a trailing `# vX.Y.Z` comment (Renovate keeps digests fresh). New workflow steps must follow this.

## Suggested Defaults (active)

- issue first
- draft PR first
- linked issue required
- worktrees under `.worktrees/`
- conventional commits
- verification notes required in every PR
