# Contributing to agentbrainsystem

Thanks for considering a contribution! This is a deliberately small, local-first project — the
goal is to do a few things well. Bug reports, focused PRs, and docs fixes are all welcome.

## Setup

Requires **Node ≥ 22**.

```bash
git clone https://github.com/victorbjuliani/agentbrainsystem.git
cd agentbrainsystem
npm install
npm run build      # compiles to dist/ and provides the `abs` CLI
```

## Before you open a PR

Everything must pass the single validation command:

```bash
npm run check      # lint → typecheck → test
```

Optional full-system check (built binary + MCP + hooks + UI):

```bash
npm run test:e2e   # needs `npx playwright install chromium` once
```

Performance-sensitive change? Re-run the benchmark and mention the numbers:

```bash
npm run bench
```

## Workflow & conventions

This repo follows the conventions documented in dedicated, canonical docs — please read them rather
than duplicating their rules here:

- **[`docs/engineering-workflow.md`](docs/engineering-workflow.md)** — branch & commit conventions,
  worktrees (`<repo-root>/.worktrees/`), PR rules, review expectations, validation baseline.
- **[`docs/testing-strategy.md`](docs/testing-strategy.md)** — what to test and how; tests + docs ship
  with the change.
- **[`docs/agent-handbook.md`](docs/agent-handbook.md)** — repo onboarding: architecture, core commands,
  the index lifecycle (`embed → persist → recall`), and gotchas.
- **[`docs/adr/`](docs/adr/)** — why things are the way they are. Significant architectural changes
  should add or update an ADR.

A few essentials:

- **Sensitive areas** (change with tests): the index lifecycle (`embed → persist → recall`) and the
  MCP tool contract.
- **Tests + docs travel with code** — a PR that changes behavior updates the relevant tests and docs.
- Keep PRs focused and reviewable. Smaller is better.

## Reporting bugs & ideas

Open an issue — [GitHub Issues](https://github.com/victorbjuliani/agentbrainsystem/issues) is the
source of truth for requirements and roadmap. Include repro steps for bugs (a sandboxed `ABS_HOME`
snippet is ideal).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
