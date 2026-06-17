# ADR 0005 — Per-prompt injection performance (FTS-first)

**Status:** accepted · **Date:** 2026-05-20 · Depends on: #3 (store), #6 (recall) · Decides design of: #19 (UserPromptSubmit hook)

## Context

The live-memory initiative adds a `UserPromptSubmit` Claude Code hook (#19) that recalls
memory relevant to each prompt and injects it as `additionalContext`. This runs on the
**interactive critical path**: it fires before every prompt the user submits and is bounded by
a registered hook `timeout`. If it is slow it degrades every turn; if it blocks it must still
exit 0 (the non-fatal contract from ADR-0004).

The hook runs as a **fresh `node` process per prompt** (Claude Code spawns the command, pipes
the payload on stdin). So the per-prompt cost is `node startup + module import + recall`, not
just the recall query in a warm REPL.

The existing `Recall.recall` (#6) is hybrid: it ALWAYS calls `provider.embed([query])` to get
a query vector for the vector KNN leg, then fuses with FTS via RRF. The local embedding
provider (`Xenova/all-MiniLM-L6-v2`) builds its `feature-extraction` pipeline lazily and
memoizes it **per process** — but a per-prompt hook is a new process every time, so the
pipeline is **cold on every invocation**. There is no warm resident process today.

This spike (#17) measures the two legs to decide what the MVP per-prompt path may depend on.

## Measurements

Reproducer: `scripts/bench-recall.mjs` (synthetic store in a temp DB, never touches real data).
Machine: this maintainer's dev laptop (Node v26, darwin/arm64), model already in the local
transformers.js cache. Numbers are stable across repeated runs.

**FTS5-only search** (`store.searchFts`, k=50, broad query = OR of ~12 distinct terms — a
realistic upper bound for a prompt's worth of tokens):

| Store size | p50 | p95 | p99 | max |
| ---------- | ---- | ---- | ---- | ---- |
| 3,000 obs  | 2.3 ms | 2.4 ms | 2.5 ms | 2.5 ms |
| 5,000 obs  | 3.9 ms | 4.1 ms | 4.4 ms | 4.4 ms |
| 10,000 obs | 7.8 ms | 8.1 ms | 8.5 ms | 8.9 ms |

**Cold-process fixed costs** (fresh `node` process, as the hook actually runs):

| Component | Cost |
| --------- | ---- |
| `import better-sqlite3 + sqlite-vec` | ~14 ms |
| `import @huggingface/transformers` | ~64 ms |
| local embedding **cold pipeline build + first embed** (model already cached) | ~120–250 ms |
| local embedding **warm embed** (same process, 2nd call) | ~2 ms |
| local embedding **first-ever embed** (model NOT cached → network download) | **~35 s** |

## Findings

1. **FTS5 is effectively free on the per-prompt path.** Even at 10k observations the search is
   p95 ≈ 8 ms; add ~14 ms of cold sqlite import and the whole FTS recall fits in well under
   **30 ms** end-to-end in a cold process. It scales linearly and gently with store size.
2. **The embedding leg cannot live on the per-prompt path as-is.** Because the hook is a fresh
   process every prompt, the embedding pipeline is cold *every time*: +64 ms import +120–250 ms
   pipeline build = **~200–300 ms added latency per prompt**, on top of FTS — a 25–75× tax for
   a leg whose marginal recall quality on short prompts is unproven. Worse, the **first-ever**
   invocation on a machine with no model cache pays the **~35 s download** inline; under a hook
   timeout that is a guaranteed timeout-and-drop on the user's first prompt after install. This
   is the landmine.
3. **A warm resident process would erase the embedding tax (~2 ms warm embed) but is not
   justified for a solo maintainer right now.** It means running and supervising a long-lived
   daemon (lifecycle, port/IPC, crash-restart, staleness, cross-platform service mgmt) purely to
   keep one pipeline warm. That is a meaningful ops surface for one person, and the FTS-first
   path already meets the interactive bar. Defer it behind a flag with a concrete trigger.

## Decision

1. **The MVP per-prompt path (#19) is FTS-only.** It MUST NOT call `provider.embed`, so it never
   pays the cold-pipeline tax and can never hit the ~35 s download landmine. Recall on this path
   uses `store.searchFts(toFtsQuery(prompt), k)` directly (a new `Recall.recallFts` method that
   reuses the existing safe `toFtsQuery` tokenizer and the FTS store primitive — no new SQL, no
   embedding dependency).
2. **Performance baseline #19 must respect (Gate 5):** the FTS-only per-prompt recall, measured
   as the query operation against a ≥5,000-observation store, must stay **p95 ≤ 25 ms** (≈6× the
   measured 4 ms headroom, absorbing CI/cold-cache variance). A regression benchmark test in #19
   asserts this. The end-to-end cold-process budget (import + query) target is **≤ 75 ms**, kept
   comfortably inside any reasonable hook timeout (#19 registers a small self-bound timeout per
   ADR-0004).
3. **Bound the result** so injection stays cheap and the context block stays small: top-K
   (small, e.g. ≤ 8), an FTS score/rank threshold, a token/char budget on the injected block,
   and dedupe. Details land in #19; the baseline above is the latency contract.
4. **Vector / warm-resident path = flagged follow-up, OFF by default.** Re-enable the embedding
   leg on the per-prompt path ONLY behind an explicit opt-in (e.g. `ABS_HOOK_RECALL=hybrid`) AND
   only once a warm resident embedding process exists to make the embed ~2 ms instead of
   ~250 ms. **Trigger to revisit:** measured evidence that FTS-only recall quality is
   insufficient on real prompts (user-visible misses), or a warm-resident daemon shipping for an
   independent reason. Until then the hybrid path is not on the interactive critical path.

## Consequences

- **Positive:** the per-prompt hook is fast (sub-30 ms typical), cannot be blocked by a model
  download, and adds zero new runtime dependencies — it reuses store + tokenizer already shipped.
  $0 / offline default is preserved. The non-fatal/timeout contract (ADR-0004) has comfortable
  headroom.
- **Negative / trade-offs:** FTS-only recall is lexical, not semantic — a prompt phrased with
  different vocabulary than the stored observation may miss matches that the vector leg would
  catch. Accepted for the MVP: the durable insights worth injecting (lessons/decisions from
  consolidation, #12) tend to share vocabulary with the work that produced them, and the cost of
  the semantic leg on a cold per-prompt process is disproportionate.
- **Untested by design:** the warm-resident embedding path (no daemon exists yet). The
  first-ever-download 35 s figure is the documented transformers.js cold-download cost, not
  re-measured here (the model is cached on this machine); it is the *reason* embedding is barred
  from the per-prompt path regardless of its exact value.

## Alternatives rejected

- **Reuse `Recall.recall` (hybrid) on the per-prompt path.** Always embeds → cold pipeline tax
  every prompt + the first-prompt 35 s download landmine. Rejected for the interactive path.
- **Ship a warm resident embedding daemon now.** Best latency, but a daemon's lifecycle/ops cost
  is unjustified for a solo maintainer when FTS-first already meets the bar. Deferred behind a
  flag with a concrete trigger.
- **Pre-warm the pipeline at SessionStart (#16).** SessionStart also runs as a short-lived hook
  process; the warmed pipeline would not survive into the separate per-prompt processes. Only a
  persistent resident process helps, which is the deferred option above.

## Addendum — 2026-06-15 (#141, kind-weighted re-rank)

The FTS-only per-prompt path now optionally re-ranks within the bound from Decision #3 so
curated/durable kinds (`decision`/`lesson`/`note`) outrank raw turns — the signal-first lever
that makes recall useful before any consolidation/optimize runs. `recallFts({ rankByKind: true })`
over-fetches a candidate pool (`max(limit*5, 40)`) from `store.searchFts` (which now also returns
`kind`) and re-ranks each candidate by `1/(DEFAULT_RRF_K + pos) × kindWeight(kind)`; it is a
multiplier, not a filter (when nothing durable matches, order collapses to pure FTS). This
directly realizes the Consequences note above — that the durable insights worth injecting are
exactly what should rise to the top.

**No change to the latency contract.** The re-rank stays on the embedding-free path (still no
`provider.embed`) and adds only an over-fetch + an in-memory sort of ≤100 rows. The Gate 5
benchmark now measures both production pool sizes — the prompt hook (`limit 8`) and the
PreToolUse decision lens (`limit 20` → 100 candidates), both with `rankByKind` — and all stay
well under **p95 ≤ 25 ms** (measured p95 < 6 ms). The hybrid `recall()` re-rank and a recall
noise floor are deferred to follow-ups.

## Addendum — 2026-06-16 (#143, hybrid `recall()` kind-weighted re-rank)

The deferred hybrid re-rank above is now done. `Recall.recall(query, { rankByKind: true })` — the
path the MCP `recall` tool uses — re-orders the WHOLE fused pool by `fusedScore × kindWeight(kind)`
(not a truncated window, so a durable hit deep in the pool that should win is never dropped). `kind`
comes from the FTS leg for free (`searchFts` already returns it); vector-only candidates are resolved
in ONE batched `MemoryStore.kindsByIds` query, so `getObservation` stays bounded to `≤ limit` exactly
as before. Default `false` keeps the pure fused order byte-identical for any non-opted caller.

**Score contract — deliberate divergence from `recallFts`.** Unlike the in-process FTS path (where
`rankByKind` makes `score` the weighted value), the hybrid path keeps each hit's `score` = the raw
fused RRF value; the kind weight drives **ordering only**. Rationale: `recall()`'s `score` crosses
the MCP wire (`server.ts` serializes `score.toFixed(6)`), and emitting a weighted score would mix two
incomparable regimes (durable ×2.5 vs raw ×1) in one response — a relevance number a client may
threshold/sort. Ordering-only weighting gives durable-first results without corrupting the wire signal.

**Stale safety.** The hybrid path has no built-in freshness step, so kind-weighting alone could lift a
*stale* curated decision to the top of an MCP result. The tool therefore runs `annotateFreshness` after
recall — stale hits sink below fresh (regardless of kind) and carry `anchorState` over the wire — so a
curated-but-stale fact can never be promoted to #1 untagged.

**Latency.** A new Gate 5 bench seeds BOTH indexes (FTS + vec0) and measures `recall({rankByKind})` at
`limit 10`; the full-pool weight + the batched kind lookup stay under a generous async budget
(p95 ≈ 6 ms, budget 50 ms = 2× the FTS ceiling to absorb the embed + KNN leg the FTS path skips).

The recall **noise floor** (#144) remains deferred: a bm25/RRF floor isn't normalized across queries,
so a mis-calibrated threshold suppresses genuinely-relevant memory (a false negative is worse than the
junk it removes) and needs real-store calibration. Note the implicit floor that already exists —
kind-weighting only reorders *pool members*, i.e. observations that already matched in at least one leg;
it can never manufacture relevance, which bounds the harm of shipping ranking before the floor.

## Addendum — 2026-06-16 (#144, recall noise floor — data-calibrated)

The deferred floor is now shipped, calibrated from a read-only spike over the real 11k-observation
store rather than a guessed constant. Probing 6 on-topic vs 6 off-topic queries gave a clean,
**corpus-independent** separator: **query-token coverage** (the fraction of the query's TOPIC
tokens — content tokens minus EN/PT stopwords — the hit contains). Off-topic noise matched exactly
ONE (usually common) token — coverage ≤ 0.25; on-topic hits covered most of the query — ≥ 0.75.
(Stopword stripping is load-bearing: the per-prompt hook floors the RAW user prompt, so without it
a verbose "can you remind me what we decided about X" would dilute a real match below the floor —
Codex review on PR #175.) The hybrid vector leg's cosine
(derived from the unit-vector L2 distance, `1 − d²/2`) separated too (off ≤ 0.35, on ≥ 0.66) but
bm25 magnitude did not generalize. Thresholds: **coverage ≥ 0.40**, **cosine ≥ 0.45** — both with
wide margins, both env-tunable (`ABS_RECALL_MIN_COVERAGE`, `ABS_RECALL_MIN_COSINE`; `0` disables).

**Design.** A hit clears the floor on coverage OR (where a vector cosine is available) cosine, so a
genuine **paraphrase** (low literal overlap, strong semantic match) is not suppressed. The FTS-only
path floors on coverage alone — safe there because FTS only ever returns lexical matches, so there is
no paraphrase to lose. The floor is **opt-in** (`noiseFloor`), enabled on the NL injection paths
(the per-prompt UserPromptSubmit hook + the MCP `recall` tool) and deliberately NOT on delete-by-search
(must find every match) nor the PreToolUse symbol-bag lens (its synthetic query is a different
distribution the spike didn't calibrate). When the whole candidate pool fails the floor, the path
returns `[]` — "nothing relevant" instead of best-of-the-junk (the LIVE-01 symptom).

**Latency.** The floor reads each candidate's content (a `getObservation`) to score coverage; on the
hot per-prompt path it adds at most one fetch per candidate it skips, bounded by the over-fetch pool.
Measured p95 ≈ 6.7 ms (limit 8, rankByKind + noiseFloor) — comfortably under the 25 ms Gate 5 ceiling.
