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

## Suggested Defaults (active)

- issue first
- draft PR first
- linked issue required
- worktrees under `.worktrees/`
- conventional commits
- verification notes required in every PR
