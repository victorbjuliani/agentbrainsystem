# ADR 0015 — Creature UI: renderer paradigm + tray shell architecture

- **Status:** Accepted (F1 + F1 polish + F2 implemented & verified; F3 tray code-complete, cross-OS build via `release.yml`)
- **Date:** 2026-05-23
- **Issue:** creature-ui (the memory visualizer REFRESH)
- **Deciders:** solo maintainer
- **Supersedes:** the node-link / force-graph frontend of ADR 0002 (the `render.ts`
  paint and the `force-graph`/`d3-force` dependency)
- **Relates to:** ADR 0002 (UI build pipeline), ADR 0007 (UI write-path security),
  `docs/DESIGN.md` (§0–§13, the visual intent), and the disruptive-ideation session
  `~/Ideas/disruptive-ideation/2026-05-23-memoria-agente-experiencia-viva.md`

## Context

The node-link memory graph (ADR 0002, issue #11) optimized for "looks like a brain"
but degraded into an illegible hairball at scale (504 obs / 202 nodes). A
disruptive-ideation session reframed the JTBD from **tool** to **experience**: the
function (recall) happens live in the harness; the UI is an emotional showcase and a
launch artifact. The chosen form is a **bioluminescent jellyfish** whose anatomy
encodes the memory (DESIGN §11). A killer-test spike (`.spike/creature-killer-test/`)
rendered the real store as a creature in three.js WebGL and was accepted as legible
and modern.

Two delivery surfaces are co-equal (owner decision): an **immersive window** and a
**system-tray companion** that must run cross-OS (macOS + Windows + Linux).

## Decision

### 1. The creature is a new projection of the existing data — the data path does not change
`buildGraph(store, query) → GraphData (GRAPH_CONTRACT_VERSION) → GET /api/graph`
stays exactly as-is (the index lifecycle and the MCP contract are untouched). The
creature renderer (`src/ui/client/creature.ts`) consumes the same `ViewGraph`
projection the node-link did. Anatomy→data mapping: dome = consolidated core +
similarity neural mesh; tentacle = session; bead = observation (coloured by `kind`);
brightness/position = recency; the 12 most-recent observations pulse (the live delta).

### 2. WebGL2 single-path in the MVP; WebGPU deferred
The killer test validated the visuals in `THREE.WebGLRenderer` (WebGL2) with HDR
bloom (`UnrealBloomPass`) + ACES tone mapping (`OutputPass`). Maintaining both a
WebGPU/TSL path and a WebGL2 fallback from day one is double the shader/bloom
surface with no proven need. WebGPU is a post-MVP optimization behind `navigator.gpu`.

### 3. Live tray pulse reflects ingest only, not recall
The tray "pulses when the agent learns" via polling — either `GET /api/stats`
(window) or rusqlite counts (tray). The pulse is driven by `maxObservationId()`
growing (an INSERT). **Recall does not write to the store**, and observing it would
mean touching the MCP/hooks lifecycle, which is forbidden. So "pulse on live recall"
(DESIGN §12-A) is explicitly out of the MVP.

### 4. `GET /api/stats` — additive, read-only, counts-only
A new GET-only route (`src/ui/server.ts`), 127.0.0.1-bound, same `SECURITY_HEADERS`,
returns `{ sessions, observations, maxObservationId, newSince? }` — **counts only,
never observation content** (a leak-guard test asserts this). It does not change
`GRAPH_CONTRACT_VERSION` (it is a new route, not a `GraphData` change).

### 5. Tray shell is "thin/hybrid" — resolves the cross-OS packaging risk
The always-on tray (Tauri 2.0, planned F3) reads **only counts** directly via Rust
`rusqlite` — no Node, no `better-sqlite3` native bundle in the always-on process, so
it is trivial on all three OSes. The full immersive window (which needs `buildGraph`
+ similarity vectors) opens **on demand**: the tray spawns the `abs ui` Node server
as a sidecar (discovering the real port from the server's stdout — never hard-coding
7717) **or** falls back to opening the system browser. `buildGraph` is never
reimplemented in Rust (no duplication of the sensitive projection). The dbPath the
Rust side reads must match `loadConfig` precedence (`ABS_DB_PATH` → `ABS_HOME` →
`~/.agentbrainsystem/memory.db`); the contract is that the sidecar emits the resolved
dbPath (with the port) on stdout so the tray and window never diverge.

### 6. The node-link renderer is retired (not kept behind a flag)
Because the creature preserves curation (search via `scope.ts`, inspector, and the
gated delete via `delete-client.ts` — all data-layer modules reused intact), the
node-link paint is removed rather than kept as a fallback: `render.ts`,
`occlusion.ts`, `node-size.ts` (and their 2D-geometry tests) are deleted, and
`force-graph` + `d3-force` dropped. `ViewNode` becomes `= GraphNode` (no x/y/radius/
phase/breathRate); the creature derives all geometry from the wire fields. The pure
geometry lives in `creature-geometry.ts` (unit-tested without WebGL — the substitute
for the deleted 2D-geometry tests).

## Consequences

**Positive:** one renderer, one client bundle served to both the browser window and
the Tauri webview; the contract and lifecycle are untouched so nothing downstream
migrates; the always-on tray carries zero native-packaging risk; curation survives.

**Negative / trade-offs:** WebGL2 shader correctness is not unit-testable (audited
visually by `frontend-auditor`, the repo's existing policy); the bundle grows (~575 KB
with three bundled offline, no CDN); the tray's full-window path still needs the Node
sidecar packaged per-OS (deferred to F3, de-risked by the browser fallback).

**Build / repo:** three.js is bundled by esbuild (`scripts/build-ui.mjs`), offline-first.
F3 adds `src-tauri/` (versioned Rust source) with `src-tauri/target/` gitignored; the
3-OS release build runs in a tag-triggered `release.yml`, **not** the PR `ci.yml`
(keeps CI lean).

## Status of work

- **F1 (renderer):** done — `creature.ts` (WebGL2 + bloom + ACES + OrbitControls),
  `creature-geometry.ts` (TDD), node-link retired. Verified in the real app.
- **F1 polish:** done — light-mode (additive→normal blending swap + pigment + diffuse
  shadow, DESIGN §8), WebGL2-absent fallback (`CreatureUnsupportedError`). Empty-store /
  no-results already handled by `overlays.ts` (not duplicated). Verified dark + light +
  empty + no-results via agent-browser.
- **F2 (`/api/stats`):** done — TDD, leak-guarded.
- **F3 (tray):** code-complete — `src-tauri/` (Tauri 2: tray + popover + read-only
  rusqlite counts + `abs ui --no-open` sidecar). NOT compiled locally (cargo can't reach
  crates.io behind the dev proxy); cross-OS build verification delegated to `release.yml`.

## Known follow-ups (from Gate 2 local-code-review, to address when Rust builds)

- **Tray idle-throttle (§13/§10):** the stats poll is a fixed 5 s `loop` with no
  focus/idle pause. Low impact (a SQLite count, not a render loop) but the spec wants it
  paused when unfocused — add a window-focus gate.
- **Blocking sidecar read on the menu path:** `open_ocean` does a blocking `read_line`
  on the `abs ui` stdout; invoked from the tray *menu* (main thread) it can freeze the
  tray for the Node startup window. Move the read to a worker thread (the popover-button
  path already runs off-main as a command).
- **`abs` PATH resolution for GUI launch:** a `.app`/tray launched from Finder/Dock has a
  minimal `PATH` that often omits the npm global bin — `Command::new("abs")` would
  `ENOENT`. The error is surfaced (not silent), but bake/resolve the path or document it.
- **Commit `Cargo.lock`:** an application should pin its lockfile for reproducible release
  builds; it could not be generated locally (no registry access). `tauri-action` produces
  one on the first `release.yml` run — commit it then.
- **Mutex poison tolerance / first-ingest pulse:** harden `last_max_obs_id.lock()` with
  poison tolerance and document the intentional `*last != 0` first-ingest guard.
