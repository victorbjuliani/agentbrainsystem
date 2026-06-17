---
type: adr
title: "ADR 0017 — Auto-distill cadence: optimize by default, two-signal staleness"
description: "Auto-distill cadence: optimize by default with two-signal staleness."
timestamp: 2026-06-15T21:47:23-03:00
status: accepted
---

# ADR 0017 — Auto-distill cadence: optimize by default, two-signal staleness

**Status:** accepted · **Date:** 2026-06-15 · Closes: #138 (optimize shouldn't be
optional), #148 (advance the staleness cursor when a run promotes nothing) · Depends on:
#12 (consolidation), #21 (optimize loop), #135 (project-scoping), #140 (index-visible
auto-memory writes), #146/ADR-0016 (curation gate) · **Supersedes** the single optimize
cursor of #16/#21 (the `optimize:cursorObsId` watermark — see §Cursor model).

## Context

`abs` captures every session continuously but distilled **nothing** by default. The two
distillation steps were both opt-in and never ran on a real install (measured on the
maintainer's live store, 2026-06-15: ~98% raw turns, ~0.5% durable; "11,051 observations
since the last optimization"):

- `consolidate` (#12): an LLM distills raw turns → durable `lesson`/`decision`
  observations (`source='consolidate'`, recallable). Unused.
- `optimize` (#21): promotes durable observations → files (auto-memory + git-tracked
  `CLAUDE.md`). Unused — and, because it can only promote what `consolidate` produced,
  automating `optimize` alone finds nothing (#148's stuck-cursor case).

Automating distillation safely needed two prerequisites that now exist: the **curation
gate** (#146/ADR-0016) so a cadence never auto-appends trivia, and **index-visible
auto-memory writes** (#140) so promoted lessons surface in Claude Code's native context
without any recall-ranking work.

## Decision

### Cadence — `consolidate → auto-memory` only, never `CLAUDE.md`

A non-interactive runner `abs maintain --auto` (`src/maintain/run.ts`) drives the existing
shared cores end to end:

1. acquire the dedicated cadence lock (below); a held lock → `{ skipped: 'locked' }`, zero
   LLM, no advance,
2. no `config.llm` → `{ skipped: 'no-llm' }` (consolidate cannot run without a provider),
3. `consolidate` the newest unconsolidated session (idempotent skip is a fine no-op),
4. `generateOptimizations` — the $0 heuristic floor **+** the billable LLM judge (#146),
5. auto-apply **only `auto-memory`-target** candidates (lessons); **skip** `claude-md`
   (decision) candidates, count them, log `N decision(s) pending manual \`abs optimize\``,
6. advance the kind/project cursors per the keep-set partition (§Cursor model),
7. record the observability rollup (§Observability).

**Scope is deliberate.** The git-tracked `CLAUDE.md` is the always-loaded project
contract; an automatic writer must never touch it. Lessons promote to the project's
auto-memory entry (`consolidated-lessons.md` + an additive `MEMORY.md` pointer, the #140
path), which Claude Code loads into native session context at SessionStart — so the
distilled knowledge surfaces the moment the cadence lands, independent of recall ranking.
Decisions accumulate in the store and wait for a manual `abs optimize`; their cursor keeps
nagging until then.

### Default-ON when an LLM is configured; explicit, auditable opt-out

- Auto-distill is **default-ON**. It can only run when an LLM is configured (consolidate
  needs one); with no LLM the cadence is a benign no-op and the banner falls back to the
  manual nag.
- `ABS_AUTO_DISTILL` (default ON; accepts `0/1/true/false/on/off`, case-insensitive) is the
  opt-out. `DISTILL_MIN_OBS` (default 25, reusing the staleness bar) is the per-session
  threshold below which a session is too small to be cadence-due. Both are flat,
  env-driven `AppConfig` fields (matching the `ABS_RECALL_SCOPE`/`ABS_EMBED_DIM`
  convention), not a nested object.
- **One-time notice** (kv_meta-keyed, reusing the #52 soft-notice mechanism, surfaced in
  the SessionStart injection). The first time auto-distill is about to run it states
  explicitly: (a) it spends LLM tokens — **one consolidate call per qualifying session that
  ends**, (b) it runs in the background after a session ends and writes only the local
  auto-memory file (never `CLAUDE.md`), and (c) the exact opt-out `ABS_AUTO_DISTILL=0`.
  Automatic LLM spend must never be a silent surprise.

### Trigger — SessionEnd evaluates cadence-due, then spawns detached

After the existing `ingestSingleSession` + `runPostCaptureMaintenance`, SessionEnd
evaluates **cadence-due**: an LLM is configured **and** `ABS_AUTO_DISTILL` is not opted out
**and** the just-ended session is substantial (`countObservationsBySession ≥
DISTILL_MIN_OBS`). If due, it **spawns the runner detached + unref'd** (the `openBrowser`
pattern: `spawn(... { detached: true, stdio: 'ignore', shell: false })` +
`child.on('error', …)` + `child.unref()`) and returns immediately. The hook path stays as
fast as today — **no LLM/network call on the hook**. Spawn failure is swallowed (ADR-0004
fail-open).

### Dedicated cadence lock — atomic ownership, not the rebuild lock

`src/store/cadence-lock.ts` is a NEW `.cadence.lock` primitive (sibling of `write-lock.ts`),
**not** `acquireRebuildLock`. Reusing the rebuild lock is rejected: the cadence holds it for
the whole consolidate+optimize run (seconds), which would force every concurrent SessionEnd
ingest to defer (#103). The cadence's own writes go through the normal WAL/`busy_timeout`
path; the cadence lock ONLY serializes cadence-vs-cadence.

`acquireCadenceLock(dbPath)` **returns ownership atomically** from the `wx` create
(`{ acquired: boolean }`). There is **no** pre-acquire `isLocked()` read — that read is
itself the TOCTOU two near-simultaneous SessionEnds would both pass, double-billing the LLM.
A stale lockfile (mtime past `CADENCE_LOCK_TTL_MS`) is stolen (dead holder); `heartbeat`
refreshes the mtime across a slow LLM call; `release` is idempotent and only removes a
lockfile we still own. This closes the double-billable-LLM window the cross-process
`priorConsolidation` idempotency check cannot.

## Cursor model — two-signal staleness (supersedes the single cursor)

The old single `optimize:cursorObsId` watermark conflated "needs consolidate" with "needs
optimize" and was global across kinds and projects. It is **replaced** by two independent
signals, both project-scoped to the session's resolved project.

### "Needs consolidate" = a session-level anti-join, NOT an id cursor

A consolidate cursor in id-space is unsound: `consolidate` is per-session, newest-active
first, distilling one whole session per pass, while raw turns of OTHER still-unconsolidated
sessions can sit at *lower* ids. A global high-water cursor would strand those sessions
below it — never nagged, never distilled (a silent-drop bug). So raw-pending is the count
of raw turns whose **session has no `source='consolidate'` row** (`countUnconsolidatedRawTurns`
+ `countUnconsolidatedSessions`, an `EXISTS`/anti-join, not an id compare). Exact, can't
strand a session, mirrors the cadence's own selection. **No consolidate cursor key is ever
introduced.**

### "Needs optimize" = two kind-aware, project-scoped cursors + a partition advance

Two cursors per project, keyed by target kind: `optimize:lesson:<projectSlug>` and
`optimize:decision:<projectSlug>` (the SAME `projectSlug` resolver candidate-gen uses, so
cursor scoping and generation scoping match byte-for-byte). A single global watermark is
wrong twice over: the cadence promotes lessons but skips decisions, and promotion is
project-scoped since #135.

The advance is driven by the curation **keep-set**, not the post-slice candidate list.
`generateCandidates` caps its output with `.slice(0, limit)`, so a curation survivor can be
sliced off the returned candidates by the `--limit`, not by curation — deriving curated-out
as `S_kind − candidateCovered` would mis-classify that sliced-off survivor as curated-out and
wrongly advance past it (stranding). So `generateCandidates`/`generateOptimizations` surface
the un-sliced keep-set (`survivingIds`), and the run-level advance partitions `S_kind` (that
kind's `source='consolidate'` obs above the kind cursor) against it:

- **survivors** = `keep ∩ S_kind` (survived curation — authoritative, slice-independent),
- **curated-out** = `S_kind − survivors` (dropped by the heuristic/judge — never promotable),
- **promoted** = `∪ evidenceIds` of APPLIED candidates of this kind,
- **pending-valid** = `survivors − promoted` (survived curation but not yet promoted —
  includes a declined candidate, a bare preview, a cadence-skipped decision, AND a
  `--limit`-sliced survivor).

**Advance the kind cursor to `maxConsolidatedId(project, kind)` IFF `pending-valid` is
empty**; otherwise do not advance. So: cadence lessons (all promoted-or-curated-out) advance;
cadence decisions (all skipped → pending-valid non-empty) do NOT advance, so the nag persists
until a manual `abs optimize` promotes them; all-curated-out advances (the #148 core); a
manual bare preview / all-declined run does NOT advance (no false "all caught up"). The
advance is **explicit at the run level** — `applyApprovedCandidate` no longer advances any
cursor on its own — and the SAME helper (`advanceOptimizeCursorsAfterApply`) wires into BOTH
the cadence runner and manual `cmdOptimize`, after the apply loop.

*Conservative-but-safe:* if a manual run promotes SOME and declines OTHERS of a kind,
pending-valid is non-empty, so the cursor does not advance even past the promoted ones — it
over-nags slightly but never silently strands, the correct direction for an honesty signal.

### Banner (`session-start.ts` / `staleness.ts`), project-scoped

- raw-pending ≥ threshold → "N turn(s) across M session(s) not yet distilled" → "auto
  handles it" when an LLM is configured, else "configure an LLM" / "run `abs consolidate`".
- consolidated-pending = lessons-pending + decisions-pending > 0 → "run `abs optimize`"
  (lessons auto-clear under the cadence; decisions persist until a manual promote).
- both clear → silent.

## Observability

A kv_meta rollup converts silent background spend into auditable spend, surfaced by the
`memory_status` MCP tool (additive spread block, pre-existing fields stay top-level):
`autoDistill:runs` (cumulative run count), `autoDistill:tokens` (cumulative LLM tokens,
consolidate + generate), `autoDistill:lastRunAt` (ISO timestamp of the last run).

## Migration

Forward-only schema **migration v6** (`CURRENT_SCHEMA_VERSION` 5 → 6) adds a composite index
`idx_observations_session_source` on `observations(session_id, source)` so the anti-join and
the per-kind/project filtered counts stay O(indexed) — the banner stays $0/offline. No data
transform, no destructive op, transactional `up`, idempotent re-open. The kv_meta keys
(`optimize:lesson:<slug>`, `optimize:decision:<slug>`, `autoDistill:*`) are created on first
write; absent reads default to 0/none. No historical backfill; no `CLAUDE.md` is ever
auto-written, so the git-tracked surface is untouched by rollout.

## Inherited invariants (unchanged, ADR-0004)

Idempotent (consolidate skips an already-consolidated session), append-only,
write-nothing-on-error (consolidate W1 rollback; the gated applier's backup/atomic/rollback),
fail-open (the `abs maintain` CLI and the SessionEnd spawn both swallow errors). If the
detached child is killed mid-run there is no corruption: the cursor simply doesn't advance and
the lock TTL expires, so the next SessionEnd retries.

## Consequences

- **Positive:** durable knowledge accumulates with **zero manual action** when an LLM is
  configured; the always-loaded `CLAUDE.md` stays untouched and signal; the staleness banner
  is honest (anti-join can't strand a session; the kind/project partition can't false-clear a
  skipped decision or a sliced-off survivor); spend is auditable; $0/offline preserved with no
  LLM (the banner falls back to the manual nag).
- **Negative / trade-offs:** the conservative advance over-nags a mixed manual run; the "top-3
  recall" outcome rides on **#143** (recall kind-weighting, tracked separately) — this feature
  ships the **accumulation** and the native-context value, not the recall-tool ranking.

## Alternatives rejected

- **Automate `optimize` alone.** Finds nothing to promote until `consolidate` has run (#148's
  stuck cursor) — the cadence must drive consolidate first.
- **Auto-write `CLAUDE.md`.** It is the always-loaded, git-tracked contract; an automatic
  writer must never touch it. Decisions stay manual.
- **Reuse the rebuild lock.** Couples cadence duration to every concurrent ingest's defer
  (#103); a dedicated `.cadence.lock` serializes only cadence-vs-cadence.
- **A pre-acquire `isLocked()` guard.** It is the TOCTOU two SessionEnds both pass — ownership
  must come atomically from the `wx` create.
- **A single global / single-kind optimize cursor.** Strands skipped decisions and leaks
  across projects (#135) and across the `--limit` slice — the keep-set partition over two
  kind/project cursors is the principled fix.
