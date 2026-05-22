# Design — Global brain (curated cross-project memory)

**Date:** 2026-05-22 · **Status:** approved (brainstorm) · **Builds on:** ADR-0010
(session→project binding), #47 (project-scoped recall), ADR-0009 (anchoring).

## Problem

Memory today is scoped to one project (the session's folder/cwd) or, with
`ABS_RECALL_SCOPE=global`, store-wide — which mixes in unrelated projects' raw
memory. Neither gives a **curated layer of cross-project knowledge** that should
surface in *every* project: general architecture decisions, coding standards,
personal engineering preferences. The user wants a "global brain" consulted on
every prompt, in every project, **alongside** the project brain — not instead of it.

## Decisions (from brainstorm)

1. **Curated only.** Nothing enters the global brain automatically. No auto-ingest
   of sessions, no agent-initiated promotion.
2. **User-initiated only (guardrail).** A write to the global brain happens ONLY
   when the user explicitly asks ("save this globally", "remember this for all
   projects"). The agent exposes the capability but never triggers it on its own.
3. **Creation = command + promote.** `abs remember --global` to author from
   scratch; `abs promote <id>` to lift an existing project memory into the global.
4. **Storage = reserved project (Approach A).** The global brain is a reserved
   "project" in the same store — zero schema migration, reuses FTS/vec/recall.
5. **Promote = move** (re-link `session_id`), not copy — so one decision never
   appears twice in recall.
6. **Relevance-based recall, no always-inject tier.** The global brain is recalled
   by FTS relevance, exactly like the project brain. A "pinned / always-inject"
   tier is explicitly out of scope for v1.

## Architecture

### Reserved global session (no migration)

A single reserved session holds all global observations:

- `external_id = "__global__"`, `project = "__global__"` (a module-level constant,
  e.g. `GLOBAL_PROJECT`).
- **Collision-free by construction:** ingest only ever creates sessions with
  `external_id` = a Claude Code session UUID and `project = projectSlug(entry.cwd)`,
  which always begins with the path separator (`-…`). The literal `__global__`
  cannot be produced by either path. A guard in `remember --global` / ingest
  refuses to treat `__global__` as a normal project label.
- Created lazily on the first global write (one `getOrCreateGlobalSession` helper).

### Writers (both user-initiated only)

- **`abs remember --global "<text>" [--kind decision|lesson|note]`** (CLI) and the
  MCP `remember` tool gains `scope: "project" | "global"` (default `"project"`).
  Writes an observation under the reserved global session and indexes it
  (FTS + embedding) through the existing `Indexer.write` path.
- **`abs promote <observationId>`** (CLI) + a UI action: re-links the observation's
  `session_id` to the reserved global session (a new store method
  `moveObservationToSession(obsId, sessionId)` updating the row + keeping FTS/vec
  rowids consistent). The observation, its anchors, and freshness state carry over.

The agent guardrail (decision #2) lives as an instruction in the tool description
and the agent docs: only invoke `scope:"global"` / promote when the user explicitly
asks. Mirrors the skip-decision discipline (user owns what enters memory).

### Recall (project + global, always)

- `resolveRecallProject` is unchanged (still returns the current project label).
- The store recall legs (`recallFts` / `knn` / `searchFts`) gain an
  `includeGlobal` flag (default true for the hooks/MCP path). The SQL filter
  changes from `WHERE s.project = ?` to `WHERE s.project = ? OR s.project = '__global__'`.
  (The `knn` rowid-subquery and `searchFts` JOIN both already filter on
  `s.project`; both extend to the OR form.)
- **Ranking:** project and global hits are ranked together by FTS relevance into
  the existing `TOP_K`/`CHAR_BUDGET` budget. The global brain is curated and small,
  so it does not monopolize the budget; no separate quota in v1.
- **Labeling:** each global hit is tagged distinctly in the injected block, e.g.
  `- [decision 🌐global] …`, so the agent reads it as a cross-project principle,
  not current-project memory. The fence header still names the active project.
- `ABS_RECALL_SCOPE=global` (existing store-wide mode) is unaffected — it already
  sees everything, including the global session.

### Management / visibility

- **`abs status`** reports a separate global count (observations under `__global__`).
- **`abs forget --global`** — a new selector for the reserved project, routed
  through the existing gated/preview→confirm delete (ADR-0008).
- **`abs project`** never lists or targets `__global__` (`listProjects` excludes it).
- **`abs ui`** — the global session renders as a distinct hub (color/label). May
  land in a follow-up; not required for v1.
- **Export/import** — the global session is part of the store and round-trips with
  the existing artifact; no special handling.

## Components & boundaries

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `GLOBAL_PROJECT` constant + `getOrCreateGlobalSession(store)` | Define the sentinel; lazily mint the reserved session | store |
| `MemoryStore.moveObservationToSession` | Re-link an observation (promote) keeping FTS/vec consistent | store schema |
| store recall legs (`recallFts`/`knn`/`searchFts`) `includeGlobal` | Widen the project filter to `project OR __global__` | sessions table |
| `remember --global` (CLI) + MCP `remember` `scope` | User-initiated global authoring | Indexer, getOrCreateGlobalSession |
| `abs promote` (CLI) + UI action | User-initiated promotion (move) | moveObservationToSession |
| `abs forget --global`, `abs status` global count | Visibility + pruning | existing forget/status |
| recall block renderer | Tag global hits (`🌐global`) | user-prompt-submit / pre-tool-use |

## Edge cases

- **Sentinel collision:** impossible from ingest; guarded at the write boundary.
- **listProjects / picker:** exclude `__global__` so it never appears as a target.
- **Dedup:** promote moves (no duplicate); the recall block already dedups by
  normalized content as a backstop.
- **Empty global:** recall with no global rows is byte-identical to today.
- **Delete safety:** `forget --global` goes through the same preview→confirm gate.

## Testing (TDD)

- store: recall with `includeGlobal` returns project hits **and** global hits;
  without it, only project hits; `__global__` excluded from `listProjects`.
- `moveObservationToSession` re-links and keeps the obs recallable under global,
  gone from the project scope.
- `remember --global` writes under the reserved session and is recalled in a
  *different* project's session (cross-project proof).
- MCP `remember` with `scope:"global"` round-trips; default stays project-scoped.
- recall block tags global hits distinctly.
- sentinel guard: a normal ingest never produces `__global__`.

## Out of scope (v1)

- "Pinned / always-inject" global tier (relevance-only for now).
- Multiple global scopes (personal vs team).
- UI global hub styling (may follow).
- Auto-promotion / auto-detection of "general" decisions.
