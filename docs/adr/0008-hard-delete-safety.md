---
type: adr
title: "ADR 0008 — Selective hard-delete: safety for destructive memory removal"
description: "Selective hard-delete: safety for destructive memory removal."
timestamp: 2026-05-20T23:44:57-03:00
status: accepted
---

# ADR 0008 — Selective hard-delete: safety for destructive memory removal

**Status:** accepted · **Date:** 2026-05-20 · Extends: ADR-0006 (gated apply) ·
Depends on: #3 (store), #6 (recall)

## Context

The memory layer can ingest, recall, consolidate and optimize — but until now it
could never *forget*. Users need to remove memories selectively: a leaked secret, a
mistaken session, an entire abandoned project, or anything matching a keyword. Unlike
the optimize/apply path (ADR-0006), which only ever **appends** to a user's files and
keeps a `.abs-bak` for recovery, a hard-delete **destroys** rows in the store
(observations + their vec0 + fts5 index entries). It is the second-highest-blast-radius
operation in the project and the only one with no in-product undo.

This ADR records the safety design for that delete. It deliberately **extends
ADR-0006**: same philosophy of *preview → explicit confirm → machine-readable
refusal*, applied to a destructive operation instead of a write.

## Decision

1. **One SYNC core, three surfaces.** All deletion logic lives in `src/delete/`
   (`delete.ts`), driven identically by the CLI (`abs forget`), the MCP server
   (`forget_preview`/`forget`) and the UI (Phase B2). The deletion mechanic is
   **synchronous** — it touches only SQLite reads/writes, never the embedding model or
   any network — so it can run inside one `store.transaction(...)`. Splitting the core
   per surface would duplicate the riskiest code (the actual row removal); one core
   keeps it auditable in a single place.

2. **Preview → pin → execute-only-pinned (TOCTOU closed).** Resolution (FTS search,
   project scan, session enumeration, id validation) happens **exactly once, at
   preview**, producing a concrete, deduped, ascending id set. `execute` deletes ONLY
   that pinned set — recall/resolution is **never re-run** at execute. So an
   observation that lands between preview and execute cannot be swept into a delete the
   user never saw. Two entry styles share the core:
   - **MCP/UI** (cross-call): `preview` mints a crypto-random `handle`
     (`randomUUID`) that pins the id set in a module-level TTL cache (5 min, max 256
     entries). `execute(handle)` **consumes** the handle — removed from the cache
     *before* any row is deleted — so a replayed handle hits `unknown-handle` and
     cannot re-run a destructive delete.
   - **CLI** (in-process): `previewSelector` resolves ids without a handle and
     `executeIds` deletes a caller-pinned list directly. The whole
     preview→confirm→delete loop lives in one process, so there is no replay/TOCTOU
     surface a cache would guard — no cache is used.

3. **The `forget` MCP tool takes ONLY a handle.** It never accepts a raw selector.
   This is the trust boundary (identical to apply's candidate-id): the agent can only
   delete a set the **server previewed and the user saw**. The agent cannot fabricate a
   delete target.

4. **Machine-readable outcomes, including `unknown-handle`.** Both `execute` and
   `executeIds` return `{ deleted: number[], notFound: number[] }` — ids that were
   gone by execute time land in `notFound`, never silently dropped. An invalid /
   expired / already-consumed handle raises `DeleteRefusalError` with a stable
   `reason: 'unknown-handle'`; the MCP `forget` tool catches it and returns
   `{ error, reason: 'unknown-handle' }` rather than throwing out of the tool, so the
   caller can branch without string-matching.

5. **Per-observation delete + selector-aware empty-session cleanup (no separate
   destructive primitive).** There is **no** standalone "delete a project/session"
   store primitive. ALL deletion routes through the preview/handle core's pinned id
   set (`deletePinned`), which deletes the pinned observations via
   `deleteObservation` (pruning each row's vec0 + fts5). After the observation deletes
   — **inside the same transaction**, so it is atomic — the core does a
   **selector-aware empty-session cleanup**:
   - **`bySession`**: if the named session now has ZERO remaining observations, its
     `sessions` row is dropped too — so "delete a whole session" leaves no orphan hub.
   - **`byProject`** (string or `null`): the distinct session ids of the previewed
     observations are gathered (from their still-present rows, before deletion); after
     the deletes, each of those sessions that is now empty has its row dropped.
   - **`byIds` / `bySearch`**: session rows are **never** touched — the user deleted
     specific observations, not "the session/project", so a session left empty by such
     a delete keeps its row. The CLI's `executeIds` (caller-pinned ids, per-id
     confirm) is treated as `byIds` for this reason: it may approve only some of a
     session's observations, and sweeping the row would contradict that explicit
     choice.

   **Empty-only is the TOCTOU-safe rule.** Cleanup only ever drops a session that is
   empty *at execute time*. A session that gained a NEW observation between preview and
   execute is therefore non-empty and **survives untouched**, and that new observation
   is never swept (only the pinned set is deleted) — the same pin-at-preview guarantee
   that protects observations now protects session rows.

   **`null` vs literal `'null'` semantics** (preserved by the project selector at the
   resolve layer, `idsForProject`): the `null` selector targets sessions whose
   `project IS NULL` (SQLite's `project = ?` never matches NULL, so the code branches on
   `project === null`); the literal string `'null'` is an ordinary project value matched
   only by the string selector — never by the null selector, and vice-versa. The
   surfaces preserve this: `--null-project` (CLI) / `nullProject` (MCP) is the NULL
   selector; `--project null` / `project: "null"` is the literal string.

6. **No cursor clamp (C1) — by design, load-bearing.** Deleting observations does
   **not** touch the optimize staleness cursor (`optimize:cursorObsId`). The staleness
   flag computes `pending = COUNT(id > cursor)`. Deleting rows **above** the cursor
   lowers `pending` by exactly that many; deleting rows **below** leaves it unchanged —
   the heuristic **self-corrects** without us mutating the cursor. This is only safe
   because `observations.id` is `INTEGER PRIMARY KEY AUTOINCREMENT`: AUTOINCREMENT
   guarantees ids are **never reused** after a delete, so a future insert always lands
   *above* the cursor and a deleted id can never be "re-pointed" to by a later row. A
   plain `ROWID` (which SQLite may recycle) would break this invariant — hence
   AUTOINCREMENT is load-bearing for the no-clamp decision, not incidental.

7. **`pruneIndexOrphans` backstop.** After deleting the pinned set, the core runs a
   defensive `pruneIndexOrphans` sweep so no vec0/fts5 index row can ever outlive its
   observation row, even if a per-id removal missed. This keeps the index counts in
   lockstep (vec == obs == fts) — the same invariant the rest of the index lifecycle
   guarantees.

8. **No `.abs-bak` for deletes — export-first is the only recovery.** Unlike apply
   (ADR-0006), which backs up every file it touches, a hard-delete keeps **no backup**.
   A `.abs-bak` of a deleted row would be a half-measure: it would leave the deleted
   content sitting on disk (defeating the point of forgetting a secret) while giving a
   false sense of recoverability. Recovery is **export-first only** — the CLI preview
   and USAGE both tell the user to `abs export` before deleting. This is a deliberate
   trade-off, recorded so it is not "fixed" later by accident.

## Consequences

- **Positive:** a destructive delete can only ever remove a set the user previewed and
  confirmed; the TOCTOU window is closed (pin-at-preview, execute-only-pinned); handles
  are single-use and expire; project/null semantics are unambiguous and transactional;
  the staleness heuristic self-corrects with zero cursor bookkeeping; the index can
  never be left with orphaned vectors; refusals are explicit and machine-readable
  (`unknown-handle`).
- **Negative / trade-offs:** there is **no undo** — a wrong delete is permanent, and
  the only safety net is the user having exported first. The handle TTL means an MCP
  agent that previews and then waits >5 min before confirming must re-preview. The
  module-level cache is process-local by design (a delete plan never crosses process
  boundaries), so it is not shared across a restarted server.
- **Tested:** CLI `--ids` validation (dedupe, reject empty/non-numeric/≤0), selector
  mutual-exclusion (zero or >1 → error), preview-default-writes-nothing, `--search`
  opens `ensure:false` and never embeds (FTS-only), apply-deletes; MCP tool list
  includes `forget_preview`/`forget`, `forget_preview` returns a handle + count,
  `forget(handle)` deletes and a replay → `unknown-handle` (consumed), `forget(bogus)`
  → `unknown-handle`, and zero/multiple selectors are rejected; empty-session cleanup
  (bySession drops the now-empty session row atomically; byProject drops every empty
  session row of the project; byIds/bySearch leave session rows; the TOCTOU-survival
  case — a session that gains a new obs between preview and execute keeps its row and
  the new obs); the `byIds` cardinality cap (10 000) on the UI + MCP surfaces; the UI
  serves `/` with `Content-Security-Policy: default-src 'self'` + `nosniff` + `DENY`,
  and an unexpected core fault yields a generic `{ error: 'internal error' }` 500 with
  detail only on stderr (the deliberate 400/403/409 responses are unchanged). All
  tests run against a tmp / `:memory:` store — none touch a real `~/.claude`.

## Alternatives rejected

- **Re-resolve the selector at execute (no pinning).** Would reopen the TOCTOU window:
  an observation arriving between preview and execute could be swept into a delete the
  user never approved. Pinning the resolved id set at preview is the whole point.
- **`forget` accepting a raw selector.** Would let the agent delete a set the user
  never saw. Restricting `forget` to a handle keeps the human, not the agent, as the
  trust boundary (mirrors apply's candidate-id).
- **Clamping the optimize cursor on delete.** Unnecessary given AUTOINCREMENT (ids
  never reused) and the `COUNT(id > cursor)` self-correcting heuristic; adding a clamp
  would be extra mutable state with no correctness benefit and a risk of drift.
- **A `.abs-bak` for deleted rows.** Leaves the deleted content on disk, defeating the
  purpose of forgetting sensitive data while implying a recoverability the design does
  not actually offer. Export-first is the honest, explicit recovery story.
- **Per-surface delete implementations.** Would duplicate the row-removal +
  index-prune + transaction envelope — the exact code that must not drift. One sync
  core, three thin surfaces.
- **A standalone `deleteSessionsByProject` store primitive.** The original design
  had a project-scoped destructive store method, but it ended up with zero production
  callers (the core deletes per-observation through the pinned set) — an unguarded
  destructive surface reachable outside the preview/handle TOCTOU guard. It was
  **removed**; project/session deletion is fully covered by the per-observation delete
  plus the selector-aware empty-session cleanup above, which routes through the same
  pinned-set core. Invariant: **no destructive store primitive is reachable except
  behind the preview/handle core.**
