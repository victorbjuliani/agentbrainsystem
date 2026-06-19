# docs/ change log

Chronological change history of the documentation corpus, newest-first.

## 2026-06-19

- #177 (bug fix): documented the OpenCode capture-failure operational breadcrumb (`CAPTURE_FAILED_KEY`) in `agent-handbook.md` → "OpenCode specifics" — the loud-fail path now leaves a durable marker surfaced by `abs doctor`/`abs status` + the SessionStart banner, cleared on the next successful capture (the fail-open plugin swallowed the exit code + stderr).

## 2026-06-17

- Initialization: adopted OKF house profile (ADR 0019); retrofitted tracked docs.
