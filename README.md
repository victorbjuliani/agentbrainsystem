<div align="center">

<img src="docs/assets/banner.png" alt="agentbrainsystem — persistent memory for AI coding agents" width="760" />

<h3>Persistent memory for AI coding agents — local-first, $0, and it&nbsp;actually&nbsp;recalls.</h3>

<p>
Your agent forgets everything between sessions. <b>agentbrainsystem</b> captures every
coding session — across <b>five harnesses</b> — and recalls what matters next time,
<b>100% on your machine</b>. No cloud, no account, no API keys.
</p>

<p>
<a href="https://github.com/victorbjuliani/agentbrainsystem/blob/main/LICENSE"><img src="https://img.shields.io/github/license/victorbjuliani/agentbrainsystem?style=flat-square&color=8B5CF6&labelColor=1A1825" alt="MIT License" /></a>
<a href="https://github.com/victorbjuliani/agentbrainsystem/stargazers"><img src="https://img.shields.io/github/stars/victorbjuliani/agentbrainsystem?style=flat-square&color=A78BFA&labelColor=1A1825&logo=github&logoColor=white" alt="Stars" /></a>
<img src="https://img.shields.io/badge/node-%E2%89%A5%2022-7C3AED?style=flat-square&labelColor=1A1825&logo=node.js&logoColor=white" alt="Node ≥ 22" />
<img src="https://img.shields.io/badge/tests-807%20passing-5EEAD4?style=flat-square&labelColor=1A1825" alt="807 tests" />
<a href="https://victorbjuliani.github.io/agentbrainsystem/"><img src="https://img.shields.io/badge/website-live-22D3EE?style=flat-square&labelColor=1A1825" alt="Website" /></a>
</p>

<p>
<img src="https://img.shields.io/badge/local--first-%240%20%C2%B7%20offline-8B5CF6?style=for-the-badge&labelColor=0A0810" alt="local-first · $0 · offline" />
<img src="https://img.shields.io/badge/MCP-9%20tools-22D3EE?style=for-the-badge&labelColor=0A0810" alt="9 MCP tools" />
<img src="https://img.shields.io/badge/deps-just%206-A78BFA?style=for-the-badge&labelColor=0A0810" alt="just 6 dependencies" />
<img src="https://img.shields.io/badge/storage-embedded%20SQLite-5EEAD4?style=for-the-badge&labelColor=0A0810" alt="embedded SQLite" />
</p>

<img src="docs/assets/certify-loop.gif" alt="The same proposal in two fresh Claude Code sessions over the same payments codebase — 'I'll wrap the charge call in a retry with backoff, good?'. WITHOUT agentbrainsystem the agent endorses it (a retry that would double-charge customers); WITH it, the recalled-memory block surfaces the team's hard rule — 'never auto-retry a failed charge; a timeout often means it already went through' — and the agent stops the change." width="900" />

<sub>
<a href="#why">Why</a> ·
<a href="#install">Install</a> ·
<a href="#how-it-works">How it works</a> ·
<a href="#what-makes-it-different">What's different</a> ·
<a href="#benchmarks">Benchmarks</a> ·
<a href="#connect-your-harness">Connect</a> ·
<a href="#memory-graph-ui">Graph UI</a> ·
<a href="#faq">FAQ</a>
</sub>

</div>

---

## Why

Every new session, your agent starts from zero. The decision you locked in yesterday? Gone.
The bug you already solved? It'll solve it again — differently, worse. So you copy-paste context
and re-explain the same constraints, every day. **That's a job no human should have.**

Existing agent-memory tools capture data but often fail at the part that matters:
**recall that returns the right thing**. agentbrainsystem is a deliberately small, owned
alternative that does a few things well — and runs entirely on your machine.

## Install

Requires **Node ≥ 22**.

```bash
git clone https://github.com/victorbjuliani/agentbrainsystem.git
cd agentbrainsystem
npm install && npm run build   # provides the `abs` CLI
abs setup                      # installs hooks + registers the MCP server with Claude Code
```

`abs setup` is the one-shot onboarding: it installs the memory hooks **and** registers the
MCP server with your harness (idempotent; if the harness CLI isn't found it just prints the
manual command). With no flag it targets **Claude Code**; pass `--harness <id>` for any other
supported harness (see [Connect](#connect-your-harness)). Restart the harness afterwards and
recall/remember are automatic.

The first embedding call downloads the local model (~one-time, ~35 s); after that it runs
**offline**. Everything is local by default — `$0`, no network. The store lives at
`~/.agentbrainsystem/memory.db` and is never committed.

## How it works

Three steps, zero effort once installed:

| Step | What happens | |
|---|---|---|
| **1 · Capture** | Hooks (or, for OpenCode, an in-process plugin) auto-ingest every session when it settles. | `$0 · no LLM` |
| **2 · Store** | Local embeddings in an embedded SQLite + `sqlite-vec` + FTS5 store, on your machine. | `offline` |
| **3 · Recall** | Hybrid semantic + keyword search surfaces relevant memory — at session start **and on every prompt**. | `per-prompt · MCP` |

## What makes it different

Not another write-only memory bucket. The parts most tools skip:

- 🎯 **Recall that returns the right thing — every prompt.** Hybrid semantic + keyword search,
  injected on **every turn**, not just dumped once at session start. The decision you locked in last
  week surfaces exactly when you're about to break it.
- 🩹 **Verifiable, self-healing memory — no external tooling.** Every fact your agent edits is anchored to
  real code (`file:line@commit`) by abs's **own** embedded tree-sitter index — symbol-level for TS/JS/Python,
  file-level for everything else. Recall labels each fact **✓verified / ~claimed / ⚠stale** against your
  *live* code; anchors **re-follow code when it moves** and go **stale** when it's deleted — in any git repo,
  offline, zero setup. A PreToolUse guard fires **in the loop**, before an edit lands: it flags code you're
  about to duplicate and surfaces past memory about the file you're touching.
- 🔒 **Local-first, $0, offline — for real.** No cloud, no account, no API keys, no telemetry. Local
  embeddings by default; a hosted embedder or any OpenAI-compatible LLM is **opt-in, never required**.
- 🗂️ **Project-scoped by default.** Recall is isolated per project — project B's memory never bleeds into
  project A. Promote a lesson to the global brain when it's worth sharing everywhere.
- 🪶 **Deliberately small.** 6 runtime dependencies (incl. an embedded WASM tree-sitter parser), embedded
  SQLite, no server to run. ~11k lines you can actually read.
- 🪼 **Your memory, as a living creature.** A localhost UI renders the whole store as one bioluminescent
  jellyfish whose anatomy *is* the memory — dome = consolidated core, tentacles = sessions, beads = observations (`abs ui`).
- 🎒 **Portable, no lock-in.** Export/import the whole store as a single file.

## Benchmarks

Measured on Apple Silicon (M-series), Node 26, over a synthetic 5,000-observation store.
**Reproduce with `npm run bench`** — no network, no external services.

| Metric | Result |
|---|---|
| Per-prompt FTS recall (hot path) | **p50 ~4.1 ms · p95 ~4.4 ms** |
| Semantic embed — warm (steady-state) | **~2–5 ms** (first call ~280 ms, model load) |
| Ingest throughput | **~6,000 observations/sec** |
| On-disk footprint | **~466 bytes/observation** (5k obs ≈ 2.3 MB) |
| Runtime dependencies | **5** · embedded SQLite · 0 servers |

> We benchmark on our own axis — latency, footprint, and minimalism — and publish only what's
> measured and reproducible. We don't chase a retrieval-accuracy headline number on someone else's
> dataset; if we ever publish one, it'll be on a public benchmark with the script in this repo.

## Connect your harness

Memory spans **five harnesses**, each wired the same way — `abs install-hooks` (the lifecycle
wiring) + `abs setup` (hooks + MCP registration). With **no flag** both target the detected
default (Claude Code); pass `--harness <id>` to target another:

| Harness | `--harness` id | One-shot |
|---|---|---|
| Claude Code | `claude-code` *(default, no flag needed)* | `abs setup` |
| Codex CLI | `codex` | `abs setup --harness codex` |
| Gemini CLI | `gemini` | `abs setup --harness gemini` |
| GitHub Copilot CLI | `copilot` | `abs setup --harness copilot` |
| OpenCode | `opencode` | `abs setup --harness opencode` |

`abs status` lists which harnesses are installed on this machine (and whether each qualifies
for full parity), so you know which `--harness <id>` to run. To register the MCP server
manually, or to wire a second machine (Claude Code shown):

```bash
claude mcp add agentbrainsystem -- node /absolute/path/to/agentbrainsystem/dist/cli/cli.js start
```

The 9 MCP tools exposed to the agent: `recall`, `remember`, `memory_status`, `optimize`/`apply`
(gated `CLAUDE.md` edits), `forget_preview`/`forget` (two-phase selective hard-delete),
`set_session_project`, and `promote` (move a memory into the cross-project global brain). The same
memory store is shared across every harness.

## Memory creature UI

```bash
abs ui        # serves the creature at http://127.0.0.1:7717
```

The store renders as a single **bioluminescent jellyfish** whose anatomy encodes the memory
(WebGL2 + HDR bloom): the **dome** is the consolidated core with a neural mesh of similarity, each
**tentacle** is a session, each **bead** of light is an observation (colored by kind), brightness is
recency, and the most-recent observations pulse. Dark by default (the creature glows); a light theme
turns it into a translucent pastel gel. Zoom/orbit freely, inspect, search, and prune memories right
from the canvas. Binds to localhost only and ships self-contained (works offline). Falls back to an
on-brand message where WebGL2 is unavailable.

### Tray companion (optional)

A native **tray companion** (`src-tauri/`, Tauri 2 — macOS / Windows / Linux) keeps the creature
glanceable from the menu bar: it reads counts read-only straight from the store (no Node process to
sit idle), pulses when the agent learns, and a popover opens the full "ocean" window on demand.
Cross-OS installers are built by the tag-triggered `release.yml` (it is intentionally **not** part of
the per-PR CI). Build it yourself with `cargo tauri build` (or `dev`) inside `src-tauri/`.

## CLI

```bash
abs setup                 # one-shot onboarding: install hooks + register the MCP server
abs uninstall [--purge]   # reverse of setup: remove hooks + unregister MCP (--purge wipes the store)
abs start                 # run the MCP server (what Claude Code spawns)
abs ingest [...]          # opt-in historical ingest — preview default; --apply + --all|--project <slug>
abs status                # db path, schema, counts, index staleness
abs project [...]         # set/confirm/skip the current session's project
abs remember "…" --global # add a memory to the cross-project global brain
abs promote <id>          # move an existing memory into the global brain
abs export <path>         # write the whole store to a portable artifact
abs import <path>         # load an artifact (merge | replace)
abs ui [--port N]         # serve the interactive memory graph
abs consolidate [...]     # distill a session into durable lessons (opt-in, needs an LLM)
abs optimize [...]        # turn distilled memory into gated CLAUDE.md / auto-memory edits
abs forget [...]          # selectively hard-delete memories — IRREVERSIBLE, export first
abs install-hooks [--harness <id>]  # register the memory hooks for a harness (idempotent, backup-first)
```

## Configuration

| Env | Default | Purpose |
| --- | --- | --- |
| `ABS_DB_PATH` / `ABS_HOME` | `~/.agentbrainsystem/memory.db` | where the store lives |
| `ABS_EMBED_PROVIDER` | `local` | `local` \| `gemini` \| `voyage` |
| `ABS_RECALL_SCOPE` | `project` | recall isolation: `project` \| `global` |
| `ABS_GUARD_MODE` | `warn` | PreToolUse guard: `warn` \| `block` |
| `ABS_LLM_BASE_URL` / `ABS_LLM_MODEL` | _(unset → consolidation off)_ | OpenAI-compatible endpoint for `abs consolidate` |

Out of scope (for now): multi-user/team sharing, image/vision embeddings, heavyweight consolidation tiers.

## FAQ

<details>
<summary><b>Does it send my code anywhere?</b></summary>

No. Everything runs locally and offline — no network calls, no telemetry, no account.
</details>

<details>
<summary><b>Does it cost anything?</b></summary>

$0 by default — local embeddings, no API keys. A hosted embedder or any OpenAI-compatible LLM (local Ollama or hosted) for deeper consolidation are **opt-in and off by default**.
</details>

<details>
<summary><b>Which agents does it work with?</b></summary>

Five harnesses: **Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, and OpenCode** — each
via MCP, with hands-free session capture and context injection through that harness's native
lifecycle (shell hooks for four; an in-process plugin for OpenCode). Run `abs setup --harness <id>`
to wire one (no flag = Claude Code). The same local memory store is shared across all of them.
</details>

<details>
<summary><b>Is it open source?</b></summary>

Fully — MIT licensed. Star it, fork it, read every line.
</details>

## Contributing & docs

- 🤝 **Contributing:** [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, validation, workflow
- 🌐 **Website:** https://victorbjuliani.github.io/agentbrainsystem/
- 📖 **Agent & contributor onboarding:** [`docs/agent-handbook.md`](docs/agent-handbook.md)
- 🏗️ **Design decisions:** [`docs/adr/`](docs/adr/)
- 🗺️ **Roadmap & requirements:** [GitHub Issues](https://github.com/victorbjuliani/agentbrainsystem/issues)

## License

[MIT](LICENSE) © 2026 Victor B. Juliani
