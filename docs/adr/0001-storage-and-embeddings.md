---
type: adr
title: ADR 0001 — Storage engine and embedding provider
description: Storage engine and embedding provider for the memory index.
timestamp: 2026-05-20T15:36:31-03:00
status: accepted
---

# ADR 0001 — Storage engine and embedding provider

- **Status:** Accepted
- **Date:** 2026-05-20
- **Issue:** #1 (spike)
- **Deciders:** solo maintainer

## Context

agentbrainsystem replaces `agentmemory`, whose recall was dead because the index
was never persisted/rebuilt and the embedder never ran at runtime. We need a
local-first, $0, offline-by-default memory whose `embed → persist → recall` path
survives a process restart, on a MacBook Air M1 / 8 GB.

The discovery brief (`docs/discovery/agentbrainsystem.md`) pre-selected the shape.
This spike de-risks the two central technical bets **before** any production code.

## Portability (non-negotiable)

This is a tool for everyone, not for one machine. Target OSes: **macOS and Windows**
(Linux comes free via Node). Therefore:

- No hardcoded paths — all paths derive from `node:os` `homedir()` + `node:path`.
- `better-sqlite3` / `sqlite-vec` ship prebuilt binaries for darwin-arm64/x64,
  win32-x64 and linux; `transformers.js` is JS/wasm. Nothing is M1-specific.
- "M1 / 8 GB" below is the **validation environment and footprint budget** (run light
  on a modest machine), not a requirement.
- Agent harness focus for now: **Claude Code** (ingestion #7, packaging #10 target it
  first). Codex parity is a later concern.

## Decision

### Storage / index: SQLite + `sqlite-vec` + FTS5, single embedded DB

- One `.db` file holds everything: rows, vector index (`vec0`), keyword index (`fts5`).
- No separate engine/daemon (the `iii-engine` opacity was a root cause in agentmemory).
- **Export = copy the `.db` file** (issue #8 builds the versioned wrapper).
- Driver: **`better-sqlite3`** (synchronous, fast, mature on arm64).
- Vector extension: **`sqlite-vec`** (`vec0` virtual table).

### Embeddings: `@huggingface/transformers` (transformers.js), `Xenova/all-MiniLM-L6-v2`

- 384-dim, mean-pooled + L2-normalized.
- Local default, offline-capable (`env.allowRemoteModels = false` after first cache).
- Provider stays **pluggable** (Gemini / Voyage opt-in) behind an interface (issue #4).
- **Dimension guard per vector** is mandatory — swapping providers must not silently
  corrupt the index (a fixed `float[N]` column means N must match the active provider).

### Recall math: hybrid

- Keyword (FTS5 `match` + `rank`) fused with vector KNN (`vec0` `distance`).
- Fusion = RRF over the two real result lists (issue #6) — never a positional fallback.

### Brute-force cosine fallback (MVP safety net)

- Vectors are L2-normalized, so cosine == dot product.
- At MVP scale (thousands of obs) a brute-force scan over stored vectors is viable
  if `sqlite-vec` ever misbehaves; confirmed working in the spike (self=1.0, cross=0.52).
- `vec0` is the primary path; cosine scan is the documented fallback.

## Validation (spike evidence, M1 / Node 26)

Run in `.spike/` (gitignored, throwaway). Results:

| Check | Result |
|---|---|
| `sqlite_version` | 3.53.1 |
| `vec_version` | v0.1.9 |
| FTS5 `match` returns correct row | ✅ |
| `vec0` KNN orders by distance correctly | ✅ |
| FTS5 + `vec0` coexist in one connection (hybrid feasible) | ✅ |
| transformers.js embeds, dim == 384 | ✅ |
| Embed latency, **cached/offline** | **282 ms** (2 strings) |
| Embed latency, first run (model download) | ~35 s (one-time) |
| Cosine fallback (normalized) self / cross | 1.0 / 0.5215 |

## Consequences / gotchas (carry into implementation)

- **`rowid` MUST be bound as `BigInt`.** `better-sqlite3` binds a plain JS number
  (`1`) as REAL; `sqlite-vec` rejects it: `Only integers are allowed for primary key
  values on vec`. Use `BigInt(id)` for `vec0` rowid inserts/queries. (Spike-confirmed.)
- **Vectors bind as a JSON string** (`JSON.stringify(arr)`) into `vec0`; a raw
  `Float32Array` is not accepted by the JS binding.
- First embed call downloads the model (~35 s, one-time); subsequent calls are offline.
  Ship the offline path (`allowRemoteModels = false`) as default once cached; model
  cache dir is already gitignored (`.cache/`, `models/`).
- Keep footprint low on 8 GB: batch embeds, stream ingestion, never `JSON.stringify`
  a giant payload (an agentmemory OOM cause).

## Alternatives considered

- **External vector DB (Chroma/Qdrace/etc.):** rejected — adds a daemon, breaks
  "export = copy a file", overkill for single-user local memory.
- **Hosted embeddings as default:** rejected — costs money, needs network, was the
  source of agentmemory's 429/503 burst failures. Stays opt-in.
- **agentmemory itself:** rejected — recall broken by upstream bug (#518), opaque engine.
