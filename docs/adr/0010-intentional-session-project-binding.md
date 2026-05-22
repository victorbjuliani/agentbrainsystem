# ADR 0010 — Intentional session→project binding (decision-aware ingest)

**Status:** accepted · **Date:** 2026-05-21 · Depends on: #3 (store), #7 (ingest),
ADR-0004 (hooks) · Increment of: #47 (project-scoped recall) · Gated by: #49 (spike)

## Context

The project a session is filed under is auto-derived from the transcript's directory
slug (`basename(dirname(absPath))` in `ingestClaudeProjects`). That silent derivation
pollutes the memory: worktrees, monorepo subdirs, clones of one repo at different
paths, and ad-hoc dirs (`/tmp`, `~/Downloads/teste`) all become accidental "projects".
There is no way to say "file this session under project X" or "this session is junk,
do not store it." Project-scoped recall (#47) consumes a project label; before scoping
on it, we must be able to **produce a clean, intentional label**.

Spike #49 validated the load-bearing assumption empirically: the Claude Code hook
`payload.session_id` equals the transcript filename **and** the per-line `sessionId`
field ingest groups by (one UUID, three layers). It also proved `SessionEnd` does **not**
fire on abrupt termination (SIGKILL/crash) — only on normal exit and graceful SIGINT.
So a decision cannot rely on `SessionEnd` running; it must be a durable record applied
whenever ingest next runs (at-least-once, riding the existing byte-cursor).

## Decision

1. **D1 — Binding rides `kv_meta`; no schema migration.** The decision is a row in the
   existing `kv_meta` table, keyed `session-project:<sessionId>`, value JSON
   `{ action: "set"|"skip", project?, createdAt }`. Reusing `kv_meta` (already the home
   of the ingest cursor) avoids a migration and a new lifecycle. `createSession`'s
   signature is **not** changed (blast radius: `ingest.ts` ≈ 471 nodes / 92 files within
   2 hops). A narrow new store method `setSessionProject(externalId, project)` upserts
   the `sessions.project` column — UPDATE an existing row or create one.

2. **D2 — Ingest is decision-aware at the `resolveSession` choke point.** `resolveSession`
   (one caller: `ingestFile`) reads the binding once per session per run and returns
   `number | null`:
   - **`set X`** → `setSessionProject` overrides the auto-derived project, **as an UPDATE**
     even if a prior run already created the row with the slug (the abrupt-kill window
     means ingest may have run before the decision).
   - **`skip`** → return `null`; the caller advances the byte-cursor but writes nothing
     (no session, no observation, no anchors). Any session created in a prior run is
     reconciled away (`deleteSession`, cascading observations + vec/fts + anchors).
   - **no binding** → byte-for-byte the original behavior (zero regression — the default
     and the safety net).

3. **D3 — Skip reconciles across all orderings.** A `skip` decision can arrive before
   ingest (in-loop skip), while the file is still growing (ingest-time reconcile), or
   after the session was fully ingested and its cursor is at EOF (so `ingestFile` never
   runs again). The last case is handled by reconciling **at write time**: `writeBinding`
   for a `skip` deletes any existing session immediately. The `skip` binding is still
   persisted so later appended lines (a resume) keep being skipped.

4. **D4 — Untrusted label, sanitized at the boundary.** The project name originates from
   the CLI (#51) / MCP tool (#52). `sanitizeProjectName` strips control chars/newlines,
   collapses path separators to dashes (the label is never a path), collapses whitespace,
   trims, and caps at 100 chars; an empty result writes no binding. Downstream the label
   is opaque (delete/export/recall/UI compare it as a literal string).

5. **D5 — Asymmetric TTL.** A `set` binding is a one-shot override, safe to forget once
   applied → expires after 30 days (lazy-expire on read + a `cleanupBindings` sweep once
   per ingest run). A `skip` binding expresses permanent intent ("never store this
   session") and must outlive an arbitrarily long-lived/resumed session → it is **never**
   auto-expired. Orphan-skip housekeeping is deferred (out of scope, with project
   rename/merge/delete).

## Consequences

- **Zero regression by construction:** with no binding the only added work is one
  `kv_meta` read per session that returns null; observations, cursor, and project are
  identical to before.
- **No migration, no `createSession` change** → reversible and low-risk; a partial deploy
  is safe because absence of a binding is the current behavior.
- This ADR delivers F2 (binding + store method) and F3 (decision-aware ingest). The
  interactive picker (#52) and CLI `abs project` (#51) are the human-facing writers that
  build on `writeBinding`; project-scoped recall (#47) is the downstream consumer.

## Alternatives rejected

- **A status column + reconciliation pass on `sessions`** — a migration in the index
  lifecycle plus a new reconciliation state machine; heavier than a kv row.
- **Gate/defer ingest until a decision exists** — breaks the incremental sweep and risks
  starvation when the decision never comes.
