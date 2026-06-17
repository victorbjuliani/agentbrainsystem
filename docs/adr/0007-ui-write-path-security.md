---
type: adr
title: "ADR 0007 — UI write path: security controls for selective hard-delete"
description: "UI write path: security controls for selective hard-delete."
timestamp: 2026-05-20T23:28:08-03:00
status: accepted
---

# ADR 0007 — UI write path: security controls for selective hard-delete

- **Status:** Accepted
- **Date:** 2026-05-20
- **Issue:** selective-hard-delete Phase B2 (UI write path)
- **Deciders:** solo maintainer
- **Supersedes:** the read-only / GET-only posture of ADR 0002 (and the
  `src/ui/server.ts` module header that declared "no MemoryStore write method is
  reachable from this module")
- **Relates to:** ADR 0006 (gated-apply write-safety tone), ADR 0002 (UI pipeline)

## Context

ADR 0002 shipped the memory-graph UI as strictly **read-only**: `127.0.0.1`-bound,
GET-only, with no `MemoryStore` write method reachable from `src/ui/`. Phase A of
selective hard-delete (`src/delete/`) then built a destructive, irreversible core
behind a two-phase `preview` / `execute` contract that pins an exact id set at
preview time (closing the TOCTOU window) and hands back a one-shot `handle`.

Phase B2 wires that core into the UI so a human can preview-then-delete from the
graph. This **breaks the GET-only invariant** ADR 0002 stated: the server now has a
non-GET write surface. Because the UI has no login (it is a single-user localhost
tool), the write path cannot lean on session auth. It instead relies on
defence-in-depth controls appropriate to a localhost origin, and on the Phase A
core's own handle confirmation. The destructive blast radius (a wrong delete is
unrecoverable) puts this on par with ADR 0006's gated-apply: the controls are
mandatory, fail-closed, and tested, not best-effort.

## Decision

Two routes are added, both `127.0.0.1`-only and **bodiless**:

- `POST /api/delete/preview` — read-only; runs the core `preview` and returns
  `{handle,count,items,notFound}`.
- `DELETE /api/delete` — runs the core `execute(handle)`; returns
  `{deleted,notFound}` or a clean JSON error on an unknown/expired/replayed handle.

### Why the selector lives in the query string, not a body

Neither route reads a request body. The delete **selector** travels in the query
string (`?sel=ids&ids=1,2,3` | `?sel=session&id=5` | `?sel=project&project=NAME` |
`?sel=null-project` | `?sel=search&q=…&limit=8`) and `DELETE` carries `?handle=…`.
Parsing with `URLSearchParams` (which already percent/unicode-decodes) means the
module imports **no body parser** and exposes **no request-stream surface** — there
is nothing to stream, buffer, or size-limit, so a slow-loris / unbounded-body DoS
vector simply does not exist. The parser validates `ids` as deduped positive ints
and `id`/`limit` as positive ints, mapping a malformed selector to a **400**, never
a 500.

### The four controls (all mandatory, fail-closed, tested)

**Control 1 — method gate (URL parsed before method).** ADR 0002's server returned
405 for any non-GET *before* parsing the URL. That is inverted here: the URL is
parsed first so the route decides which method it accepts. `POST` is allowed only on
`/api/delete/preview`, `DELETE` only on `/api/delete`; **every other route stays
GET-only** (a non-GET elsewhere is still 405, and a GET on the two delete routes is
405). This keeps the write surface to exactly two method+path pairs.

**Control 2 — Host / Origin allowlist (anti DNS-rebinding / cross-site).** On both
delete routes, the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`,
and `Origin` (when present) must be `http://127.0.0.1:<port>` or
`http://localhost:<port>`; otherwise **403**. The port is read from
**`req.socket.localPort`** — the *real* bound port. This matters because
`startUiServer` retries `EADDRINUSE` by creating a fresh server on the next port, so
the handler closure has no static knowledge of which port it ended up on;
`req.socket.localPort` is the only reliable in-handler source and survives the
retry. A DNS-rebinding attacker who lures the browser to a malicious page cannot
forge a matching `Host`/`Origin` for the live localhost port, and a cross-site
`fetch` carries a foreign `Origin` that is rejected.

**Control 3 — per-process CSRF token (fail-closed).** Both routes require header
`X-ABS-CSRF` to equal a token minted **once per process** from
`node:crypto.randomBytes(32)`. Absent or mismatched → **403**. Preview is protected
too, because it returns memory snippets. The token is delivered by serving `/`
through a **request-time template**: `index.html` carries a `__ABS_CSRF__`
placeholder (and a `<meta name="abs-csrf" content="__ABS_CSRF__">`), the build copies
the file *verbatim*, and the server substitutes the live token when it serves `/`.
Consequently `/` no longer flows through `serveStatic` — it is read from the
`import.meta.url` static dir (never cwd), still guarded by the same realpath
containment check, and sent with an explicit `Content-Type: text/html; charset=utf-8`.
The client reads the token from the meta tag at runtime (not a build constant) and
echoes it on every delete call.

**Control 4 — server-side handle confirmation.** `DELETE` deletes **only** the id
set a prior `preview` pinned under the supplied `handle`. The Phase A core consumes
the handle before deleting and refuses an unknown/expired/replayed handle with a
`DeleteRefusalError(reason='unknown-handle')`. The server surfaces that as a clean
**409 JSON** `{error,reason}`, never a 500. Resolution is never re-run at execute, so
the delete is exactly what the human confirmed.

### Stale-token recovery

Because the CSRF token is per-process, a server restart invalidates the token baked
into an already-loaded page. The client treats a **403 on a delete call as a stale
token** and reloads `/` to fetch a fresh one rather than leaving the user stuck. (A
403 from Control 2 also triggers a reload; harmless — the reload simply re-confirms
the legitimate origin.)

## Consequences / gotchas

- **IPv6 / `localhost` caveat.** The server binds **`127.0.0.1` only** (IPv4). On
  systems where `localhost` resolves to IPv6 `::1` first, a request to
  `http://localhost:<port>` may try `[::1]` and **fail to connect** — not a security
  failure, a reachability one. The allowlist *accepts* a `localhost:<port>` Host for
  when `localhost` resolves to v4, but a client that ends up on `[::1]` never reaches
  the server at all. The canonical URL `abs ui` opens stays the `127.0.0.1` one, so
  the happy path is unaffected; `localhost` is a best-effort convenience.
- The write path is **localhost-only, single-user** by design. These controls raise
  the bar against the realistic browser-side threats (DNS-rebinding, CSRF, a curious
  script on another tab) without pretending to be multi-user auth.
- `/` is now templated, so a CDN/proxy must not cache it across processes (moot for a
  localhost tool, noted for completeness).

## Alternatives considered

- **Keep GET-only, do deletes via the CLI/MCP only.** Rejected — the graph is the
  natural place to see *what* you are about to delete; a preview dialog over the
  visual model is the whole point of Phase B2.
- **Request body for the selector.** Rejected — adds a body parser and a request
  stream (DoS surface) for no gain; the selector is small and fits the query string,
  which `URLSearchParams` decodes safely.
- **A static per-build CSRF token (esbuild define).** Rejected — a build constant
  would be identical across processes and could leak via the bundled JS; a
  per-process CSPRNG token templated at request time is fresh per run and never lands
  in a build artifact.
- **Trusting `Host` from a captured listen port variable.** Rejected — the
  `EADDRINUSE` retry rebinds on a new port, so a captured "intended" port can be
  wrong; `req.socket.localPort` is authoritative.
- **Binding `localhost` (dual-stack) to dodge the IPv6 caveat.** Rejected — binding
  `0.0.0.0`/`::` would expose the write path to the LAN, the exact thing ADR 0002's
  `127.0.0.1`-only stance forbids. The IPv4-only bind + documented caveat is the
  safer trade.
