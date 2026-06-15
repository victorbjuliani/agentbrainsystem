# ADR 0009 — Verifiable memory: code-grounded anchoring, self-healing, contradiction guard

**Status:** accepted · **Date:** 2026-05-21 · Depends on: #3 (store), #6 (recall),
#7 (ingest), ADR-0004 (hooks), ADR-0005 (per-prompt perf) · Substrate: code-review-graph

## Context

Chat-derived memory ages silently: the code moves under it and nothing invalidates
the stale facts. A killer-test (2026-05-21) measured this on a real 3-day corpus —
~17% of symbol-level claims already obsolete, and only **~0.3%** of observations were
even code-grounded. The thesis (discovery `active-code-grounded-memory`): turn passive
memory into **active, code-grounded memory** that knows what it can still prove and
warns the agent when it is about to contradict reality. Ordering is forced by the
data: **E** (make facts verifiable) is foundational — you cannot self-heal (**B**) or
guard on (**A**) a fact that was never anchored to code.

A spike (#22) validated the enabling bet: anchoring from the `tool_use` `file_path`
(not prose) resolves **~97%** of code facts against the graph — a ~320× lift over the
passive 0.3%.

## Decision

1. **D1 — A dedicated `fact_anchors` table, not a JSON column.** Each fact (observation)
   gets 0..N anchors (`anchor_kind` symbol|file, `qualified_name`, `file_path`, `line`,
   `commit_sha`, `branch`, `state`). Reverse indexes on `qualified_name` and `file_path`
   serve self-healing's core query — "which facts anchored to symbol X?" — in O(log n),
   which a `metadata` JSON column cannot. The `observations` contract (and the MCP
   surface) stays untouched.

2. **D2 — Seed cheap at ingest, verify async.** Ingest mines Edit/Write `tool_use`
   blocks for `file_path` + defined symbols and writes `claimed` anchors (the diff is
   never stored — footprint discipline, ADR-0001). An out-of-band sweep resolves them
   against ground truth and promotes to `verified(file:line@commit)`. The graph query
   stays off the ingest hot path.

3. **D3 — Self-healing is lazy-first.** Staleness only matters when a fact is *used*, so
   the per-prompt recall hook re-verifies the anchors of the facts it is about to
   surface (`verifyOnRecall`), bounded and fail-open. A periodic reconciliation sweep
   (`healAnchors`) covers the rest. A symbol that moved is **re-anchored** (stays
   verified); one that vanished is marked **`stale`** — never deleted (auditable).
   `stale` is **recoverable, not terminal**: `verifyOnRecall` re-resolves stale anchors
   too, so a fact false-staled by a transient miss (an empty/unbuilt index, a wrong-repo
   resolution) returns to `verified` once its home index can resolve it again. Resolution
   is **strict same-file then explicit unique move**: the provider answers a `filePath`
   lookup with the symbol in *that* file or `null` — it never silently binds to a homonym
   in another file (which would seal a `verified` anchor onto foreign code), so the
   distinct re-anchor step (unique cross-file match) stays the only way an anchor moves.

4. **D4 — The guard is a read-only, fail-open PreToolUse hook.** Before an Edit/Write,
   it point-queries the graph for symbols the action would define and warns when one
   already exists elsewhere ("you may be duplicating `foo` at src/x.ts:12"). **Warn by
   default; `ABS_GUARD_MODE=block` opts into deny.** It fires only on ground truth
   (verified by construction → low FP — measured TP=100%/FP=0 on the #30 harness),
   never executes `tool_input`, and degrades to silent-allow on any error or missing
   graph. Scoped to `matcher: Edit|Write` so other tools never spawn it.

5. **D5 — `GroundTruthProvider` port isolates the graph.** A code-review-graph adapter
   (read-only SQLite) plus a null adapter behind one interface. No graph → null
   provider → everything degrades to `claimed`/warn-only and the system still works.
   This is the anti-corruption boundary and the local-first/$0/offline guarantee, and
   keeps Codex parity (the port can back onto a different ground truth).

6. **C — Branch/commit scoping.** Anchors record the `branch` they were verified on
   (FR-C1), stamped at verify time from the repo HEAD (accurate, unlike ingest time).
   Recall flags cross-branch facts. Ephemeral worktree paths
   (`.worktrees/`, `.claude/worktrees/`) are normalized to their canonical repo path at
   seed time (FR-C2), killing the worktree-path pollution the killer-test measured.

## Consequences

- New module boundaries: `src/ground-truth/` (the port), `src/anchoring/` (sweep +
  heal). The store grows anchor CRUD; recall grows `annotateFreshness`; hooks grow the
  PreToolUse guard. Schema migrations v3 (`fact_anchors`) and v4 (`branch`).
- The per-prompt hook now does bounded graph point-queries; recall bench stays well
  under the ADR-0005 budget (p95 ~8ms vs 25ms).
- Everything is fail-open and gated: no auto-deletion, no auto-block, no network, no
  model load on the hot path. A missing or stale graph degrades, never breaks.
- Open follow-ups: the verification sweep / reconciliation are library functions; wiring
  them to a schedule (e.g. SessionEnd or the optimize loop) is a later enhancement.
  Multi-repo anchor routing (a global store holds facts from several repos) resolves only
  against the provider for the active repo; **cross-project (global) facts are excluded
  from recall-time healing** so they are never false-staled or re-anchored against the
  wrong repo's index — their home repo heals them, and their state is left untouched here.
  The provider also reports **unavailable over a never-built index** so heal/sweep
  fail-open (no-op) instead of mass-staling correct anchors after a db wipe or repo move.
