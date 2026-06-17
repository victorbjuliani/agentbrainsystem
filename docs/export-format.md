---
type: export-format
title: "Export format — `abs-export` v1"
description: "The `abs-export` v1 portability artifact shape."
timestamp: 2026-05-20T16:06:43-03:00
status: active
---

# Export format — `abs-export` v1

The portable artifact produced by `exportStore` / consumed by `importStore`
(issue #8). It carries an entire memory store as a single self-describing file
that another machine can re-import and recall against **identically, without
re-embedding** — the stored vector ships with each observation.

## Why JSONL (line-delimited JSON)

The artifact is one JSON object **per line**, never one giant JSON document.

- Export streams the store out row-at-a-time (`store.iterateObservations()`),
  writing through a `WriteStream`. Import streams it back in via `readline`.
- Neither side ever materializes the whole store in a single string. This is the
  8 GB footprint discipline from [ADR 0001](./adr/0001-storage-and-embeddings.md):
  a `JSON.stringify(everything)` was an `agentmemory` OOM cause.
- Portability across macOS / Windows / Linux: import uses
  `crlfDelay: Infinity`, so `\r\n` and `\n` line endings both parse.

## Layout

```
line 1      header        { "format": "abs-export", "version": 1, ... }
line 2..S   sessions      { "t": "session", ... }            (one per session)
line S+1..N observations  { "t": "obs", ..., "vector": [...] } (one per observation)
```

Sessions are emitted before observations so the importer can resolve each
observation's `sessionExternalId` to a freshly-created local session id.

### Header (line 1)

```json
{
  "format": "abs-export",
  "version": 1,
  "createdAt": "2026-05-20T16:00:00.000Z",
  "embedding": { "provider": "local", "model": "Xenova/all-MiniLM-L6-v2", "dimensions": 384 },
  "counts": { "sessions": 2, "observations": 3 }
}
```

- `format` — must equal `"abs-export"`; import rejects anything else.
- `version` — the schema version (currently `1`); import rejects an unknown version.
- `embedding.dimensions` — the vector width the artifact's vectors were produced
  with. **It is derived from the source store's actual `vec0` column width**, not
  from the process-wide config default, so a store sized differently from the
  ambient config still exports a correct header.
- `counts` — informational snapshot at export time; import recomputes its own.

### Session line

```json
{ "t": "session", "externalId": "sess-alpha", "project": "agentbrainsystem",
  "startedAt": null, "createdAt": "2026-05-20T15:00:00.000Z",
  "meta": { "harness": "claude-code" } }
```

`externalId` is the stable, unique key used to map sessions on import. Optional
fields (`project`, `startedAt`, `meta`) are omitted when unset.

### Observation line

```json
{ "t": "obs", "sessionExternalId": "sess-alpha", "kind": "decision",
  "content": "use sqlite-vec for the vector index",
  "metadata": { "confidence": 0.9 }, "source": "test",
  "createdAt": "2026-05-20T15:00:01.000Z", "vector": [0, 1, 0, ...] }
```

- `sessionExternalId` — links the observation to its session by stable key.
- `vector` — the stored embedding as `number[]`, or `null` if the observation has
  no vector. Shipping it inline is what makes recall reproduce exactly after an
  import (no re-embedding, no provider/network dependency).

## Import

`importStore(store, inPath, { mode })`, where `mode` is `'replace' | 'merge'`.

Validation (before any mutation):

1. The header must parse, have `format === "abs-export"` and a supported `version`.
2. `embedding.dimensions` must equal the target store's `vec0` column width. A
   mismatch throws — a fixed `float[N]` column cannot accept vectors of width ≠ N.
   The check happens **before** a `replace` wipes anything, so a rejected import
   never leaves the target empty.

Per mode:

- **`replace`** — deletes every session first (cascades to observations + index
  rows), then inserts everything from the artifact.
- **`merge`** — keeps existing rows. A session whose `externalId` already exists
  is reused (not duplicated); otherwise it is created. All observation lines are
  appended.

For each imported observation: `createObservation(...)` assigns a **new** numeric
id, then the vector (if present) is written via `upsertVector(newId, vector)` and
the content is indexed via `indexFts(newId, content)`. New ids are fine — recall
identity is by content/vector, not by id.

## Versioning

`version` is bumped on any breaking change to the line shapes. A reader refuses a
version it does not understand rather than mis-parsing. Unknown line `t` values
within a supported version are ignored for forward-compatibility.

## Public API

```ts
exportStore(store: MemoryStore, outPath: string)
  : Promise<{ sessions: number; observations: number }>;

importStore(store: MemoryStore, inPath: string, opts: { mode: 'replace' | 'merge' })
  : Promise<{ sessionsImported: number; observationsImported: number }>;
```

Both take a `MemoryStore` instance (not `openMemory`) so callers and tests stay
fast and offline — no embedding provider is ever constructed by this module.
