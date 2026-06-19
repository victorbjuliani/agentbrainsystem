# docs/ change log

Chronological change history of the documentation corpus, newest-first.

## 2026-06-19

- #178 (bug fix): documented in `agent-handbook.md` → "Explicit, opt-in historical ingest" the new embed/persist failure classification for `abs ingest --apply` (clear `persisted 0 observations (embedding failed?)` line + exit 1 instead of a raw stack trace; foreground caching path so no defer) and that the detached `abs maintain --auto` bare `catch` is deliberate fail-open (ADR-0004), not masking.

## 2026-06-17

- Initialization: adopted OKF house profile (ADR 0019); retrofitted tracked docs.
