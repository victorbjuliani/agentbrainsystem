---
type: adr
title: ADR 0002 — UI build pipeline and frontend stack
description: UI build pipeline and frontend stack choice.
timestamp: 2026-05-23T20:12:47-03:00
status: accepted
---

# ADR 0002 — UI build pipeline and frontend stack

- **Status:** Accepted; **frontend stack partially superseded by ADR 0015**
- **Date:** 2026-05-20
- **Issue:** #11 (localhost read-only memory graph)
- **Deciders:** solo maintainer

> **Update (2026-05-23, ADR 0015):** the *frontend renderer* changed from a
> force-directed node-link (`force-graph`/`d3-force`) to a three.js WebGL2 creature
> (`src/ui/client/creature.ts`). The **build pipeline decisions here still hold** —
> esbuild bundles the single client offline-first (now bundling `three` instead of
> `force-graph`), served by `abs ui`. Only the paint layer and its two deps changed.

## Context

Issue #11 adds a localhost, read-only viewer for the memory store: a force-directed
graph of sessions and observations served by `abs ui`. The store, embeddings, and
MCP server are Node/ESM (NodeNext). A graph UI is unavoidably a *browser* artifact
(DOM, canvas), so the build must produce both a Node server (compiled by `tsc`)
and a bundled browser client — without the DOM types leaking into the Node build,
and without shipping a CDN dependency that breaks the offline-first posture (ADR 0001).

## Decision

### `src/ui/` module shape

| File | Role | Compiled by |
|---|---|---|
| `graph-types.ts` | The wire contract: pure type declarations + `GRAPH_CONTRACT_VERSION`. DOM-free and Node-free, so it typechecks under **both** tsconfigs. | both |
| `graph.ts` | `buildGraph(store, query) → GraphData` — pure, bounded, read-only projection. | `tsc` (Node) |
| `server.ts` | `createUiServer` / `startUiServer` — `node:http` localhost server. | `tsc` (Node) |
| `index.ts` | Barrel re-exporting the above. | `tsc` (Node) |
| `client/main.ts`, `client/app.css`, `client/index.html` | The browser SPA. | `esbuild` (browser) |

The contract types are the single source of truth shared by server and client, so the
two halves can never drift silently.

### Frontend stack: vanilla TS + `force-graph` (canvas 2D) + `esbuild`

- **`force-graph`** renders to a 2D canvas — fast for hundreds of nodes, no WebGL/3D
  dependency, no framework runtime. Matches the DESIGN.md "deep void" canvas aesthetic.
- **Vanilla TS** (no React/Vue): the UI is a single read-only canvas with light chrome;
  a framework would be pure overhead.
- **`esbuild`** bundles `client/main.ts` → `dist/ui/static/app.js` (ESM, minified) and
  emits `app.css` from the CSS imported by `main.ts`. One fast tool, no webpack/vite config.
- **`d3-force`** is available as a layout primitive for the frontend agent's real render.

### Two-tsconfig split (the crux)

The Node build (`tsconfig.json`) must NOT see DOM types, and the browser client must
NOT be compiled by `tsc` into `dist/` (it is bundled by esbuild instead):

- **`tsconfig.json`** adds `src/ui/client` to `exclude`, so `tsc -p tsconfig.json`
  compiles `src/ui/{graph-types,graph,server,index}.ts` → `dist/ui/` but skips the
  DOM client. It keeps `lib: ["ES2023"]` (no DOM) and `module/moduleResolution: NodeNext`.
- **`tsconfig.ui.json`** extends the root, overriding `lib: ["ES2023","DOM","DOM.Iterable"]`,
  `module: ESNext`, `moduleResolution: Bundler`, `verbatimModuleSyntax: false`, `noEmit: true`,
  and includes only `src/ui/client`. It typechecks the browser code (DOM globals, CSS
  imports, `force-graph`) without emitting — esbuild owns emission.

`typecheck` runs both: `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.ui.json --noEmit`.

### Fonts: `@fontsource` self-hosted, offline

Fonts are pulled from `@fontsource/{space-grotesk,inter,jetbrains-mono}` (devDeps,
bundled at build — not runtime deps). esbuild's `file` loader rewrites every
`url(./files/*.woff2)` reference to `fonts/<name>` and emits the asset into
`dist/ui/static/fonts/`. **No CDN, no network at runtime** — consistent with ADR 0001's
offline-first stance. Only the Latin subsets actually used are imported, keeping the
bundle small.

### Build & packaging

- `build` = `tsc -p tsconfig.json && npm run build:ui`.
- `build:ui` = `node scripts/build-ui.mjs` (esbuild JS API; idempotent; creates dirs).
- The whole UI ships under `files: ["dist"]`, so `dist/ui/static/{app.js,app.css,
  index.html,fonts/*}` are included in the published package automatically.
- A CI step asserts `dist/ui/static/app.js` is present in `npm pack --dry-run --json`,
  so a broken UI build (or a missed bundle) fails the pipeline rather than shipping a
  blank viewer.

### API contract: `GET /api/graph` + `GRAPH_CONTRACT_VERSION`

- The server exposes `GET /api/graph` returning `GraphData` as JSON.
- `GRAPH_CONTRACT_VERSION` mirrors the role `EXPORT_VERSION` plays for the portable
  artifact (#8): the client asserts it on every payload, so a breaking wire-shape change
  is caught loudly instead of mis-rendered.

### Security posture: read-only, 127.0.0.1

- Binds **127.0.0.1 only** — never `0.0.0.0`; the graph is never exposed to the LAN.
- **GET-only**; any other method → 405. No `MemoryStore` write method is imported or
  reachable from `src/ui/`. The viewer cannot mutate memory.
- Static serving is allowlisted by extension and guarded against path traversal: the
  resolved realpath must stay under the static dir, else 403.
- Default port 7717, with EADDRINUSE fallback to the next free port (≤10 attempts).

### Default scope by activity

The default graph (`abs ui` with no query) shows the **most recently ACTIVE session**,
resolved via `MemoryStore.listSessionsByActivity(1)` — ordered by `MAX(observations.
created_at)`, not `sessions.created_at`. Ingest wall-clock would make "latest" mean
"last ingested", which is wrong for a viewer meant to surface what the agent worked on
most recently (Gate-1 finding). Sessions with zero observations sort last.

## Consequences / gotchas

- The static dir is resolved from `import.meta.url` (`dist/ui/server.js` → `./static`),
  NOT `process.cwd()`, so `abs ui` works regardless of the launch directory. Tests run
  from `src/ui/` (no sibling `static/`), so `createUiServer`/`startUiServer` accept an
  internal `staticDir` override pointing at the built `dist/ui/static`.
- `buildGraph` enforces hard caps (NODE_CAP, EDGE_CAP, SESSION_CAP) and never calls an
  uncapped `listObservations`/`listSessions`; a 100k-row store still renders a small graph.
- Similarity edges use **stored vectors only** (`getVector` + `knn`) — the UI never
  triggers a model load (`abs ui` opens the store with `ensure:false`).

## Alternatives considered

- **React + Vite:** rejected — framework + dev-server overhead for a single read-only
  canvas; esbuild + vanilla TS is leaner and faster to build.
- **3d-force-graph / WebGL:** rejected for MVP — 2D canvas is sufficient at MVP scale and
  avoids a heavier dependency; can revisit if node counts grow.
- **CDN-hosted fonts:** rejected — breaks offline-first (ADR 0001) and adds a network
  dependency to a localhost tool.
- **Single tsconfig with DOM lib:** rejected — would leak DOM globals into the Node
  server/store code, weakening type safety on the backend.
