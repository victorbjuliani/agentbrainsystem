# agentbrainsystem

Local-first persistent memory for AI coding agents — capture, store, and **actually recall** past sessions, with portable export/import and a visual graph UI.

> Status: **MVP+** — reliable `embed → persist → recall` over MCP, JSONL ingestion, portable export/import, a CLI, and an interactive localhost graph UI (`abs ui`). Works offline on macOS/Windows/Linux.

## Why

Existing agent-memory tools capture data but often fail at the part that matters: **reliable semantic recall**. agentbrainsystem is a deliberately small, owned alternative that does a few things well instead of many things partially:

- **Reliable recall** — semantic search over past coding sessions that actually returns relevant results.
- **Distilled lessons** — optional LLM consolidation of raw session noise into durable insights/decisions.
- **Portable memory** — export and import the whole memory store as a portable artifact (no lock-in, survives machine/project moves).
- **Visual graph UI** — a localhost interface to explore the agent's memory as an interactive graph.

Explicitly **out of scope** (for now): multi-user/team sharing, image/vision embeddings, heavyweight consolidation tiers we don't need.

## Planned shape (to be confirmed in discovery)

- Ingests Claude Code / agent session transcripts (e.g. `~/.claude/projects/**/*.jsonl`).
- Local embeddings by default (no rate limits, no cost, offline); pluggable to hosted providers.
- Embedded storage with vector search.
- Exposed to agents over MCP.

## Getting started

Requires **Node ≥ 22**.

```bash
npm install        # install deps (sqlite-vec, transformers.js, MCP SDK)
npm run build      # compile to dist/  (provides the `abs` CLI)
npm run check      # lint → typecheck → test
```

The first embedding call downloads the local model (~one-time, ~35 s); after that it
runs **offline** (~280 ms). Everything is local by default — `$0`, no network, your
memory never leaves the machine. The store lives at `~/.agentbrainsystem/memory.db`
(override with `ABS_DB_PATH` / `ABS_HOME`) and is never committed.

### CLI

```bash
abs start                 # run the MCP server over stdio (what Claude Code spawns)
abs ingest [--dir PATH]   # ingest Claude Code transcripts (default ~/.claude/projects)
abs status                # real health: db path, schema, counts, index staleness
abs export <path>         # write the whole store to a portable artifact
abs import <path> [--mode replace|merge]   # load an artifact (default merge)
abs ui [--port N]         # serve the interactive memory graph at http://127.0.0.1:7717
abs --help | --version
```

(During development, run any command without building via `npm run dev -- <command>`.)

### Memory graph UI

`abs ui` starts a localhost server (default port `7717`, override with `--port`) and
opens a browser to a **read-only**, force-directed graph of the live store: session
hubs and their observations, colored by kind, with optional similarity edges
(`?similarity=1`). It binds to `127.0.0.1` only, never mutates the store, and ships
self-contained (no CDN — works offline). The default view is scoped to the most
recently active session; switch sessions or use top-N from the on-canvas controls.
Visual intent is documented in `docs/DESIGN.md`.

### Connect to Claude Code

Register the MCP server so Claude Code can `recall` and `remember`:

```bash
# global (after `npm run build`, from the repo)
claude mcp add agentbrainsystem -- node /absolute/path/to/agentbrainsystem/dist/cli/cli.js start
```

Or per-project, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "agentbrainsystem": {
      "command": "node",
      "args": ["/absolute/path/to/agentbrainsystem/dist/cli/cli.js", "start"]
    }
  }
}
```

Then ingest your history (`abs ingest`) and Claude Code can call the `recall`,
`remember`, and `memory_status` tools. Configure a hosted embedder if you prefer
(`ABS_EMBED_PROVIDER=gemini|voyage` with the matching API key) — local stays the default.

### Embedding providers & environment

| Env | Default | Purpose |
| --- | --- | --- |
| `ABS_DB_PATH` / `ABS_HOME` | `~/.agentbrainsystem/memory.db` | where the store lives |
| `ABS_EMBED_PROVIDER` | `local` | `local` \| `gemini` \| `voyage` |
| `ABS_EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | model id for the provider |
| `ABS_EMBED_DIM` | per provider (local 384, gemini 768, voyage 1024) | vector width; only set to override |

Hosted providers retry transient failures — HTTP `429`/`503` and network errors — with
capped exponential backoff + jitter, honoring `Retry-After`. A momentary rate-limit or
blip during bulk ingest is absorbed instead of aborting the whole run (the local provider
needs none of this — no network).

See also:

- `docs/agent-handbook.md` — onboarding for AI agents and contributors
- `docs/adr/0001-storage-and-embeddings.md` — storage/embedding decisions
- `docs/adr/0002-ui-build-pipeline-and-frontend-stack.md` — UI build pipeline & frontend stack
- `docs/DESIGN.md` — visual identity for the graph UI
- `docs/export-format.md` — the export artifact format
- [GitHub Issues](https://github.com/victorbjuliani/agentbrainsystem/issues) — requirements and roadmap (source of truth)

## License

See [`LICENSE`](LICENSE).
