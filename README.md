# agentbrainsystem

Local-first persistent memory for AI coding agents — capture, store, and **actually recall** past sessions, with portable export/import and a visual graph UI.

> Status: **MVP+ with a live memory layer** — reliable `embed → persist → recall` over MCP, JSONL ingestion, portable export/import, a CLI, and an interactive localhost graph UI (`abs ui`). On top of that: **hands-free capture and context injection** via Claude Code hooks (`abs install-hooks`), an **optimization loop** that turns distilled memory into evidence-backed `CLAUDE.md` / auto-memory edits (`abs optimize`), and **selective hard-delete** across CLI, MCP, and the UI (`abs forget`). Works offline on macOS/Windows/Linux.

## Why

Existing agent-memory tools capture data but often fail at the part that matters: **reliable semantic recall**. agentbrainsystem is a deliberately small, owned alternative that does a few things well instead of many things partially:

- **Reliable recall** — semantic search over past coding sessions that actually returns relevant results.
- **Live capture & injection** — Claude Code hooks auto-ingest each session ($0, no LLM) and inject relevant memory back at session start / per prompt (FTS-first, no cold-load), hands-free.
- **Project-scoped by default** — recall and injection are isolated to the current session's project, so memory from project B never leaks into project A (`ABS_RECALL_SCOPE=global` opts back into store-wide recall).
- **Distilled lessons** — optional LLM consolidation of raw session noise into durable insights/decisions.
- **Optimization loop** — turn that distilled memory into evidence-backed, gated edits to your project's `CLAUDE.md` and Claude Code auto-memory (preview → approve → apply; never automatic).
- **Selective delete** — prune wrong/stale/sensitive memories by id, session, project, or search, across CLI, MCP, and the UI (preview → confirm; hard-delete, export first).
- **Verifiable, self-healing memory** — facts edited via Edit/Write are anchored to real code (`file:line@commit`) through the code-review-graph; recall labels each as ✓verified / ~claimed / ⚠stale, anchors self-heal when code moves (rename re-anchors, removal goes stale), and a PreToolUse guard warns in-loop before you duplicate code that already exists — and surfaces recorded decisions/lessons touching the file you're editing (#48, warn-only). Fail-open and offline-safe (`docs/adr/0009-verifiable-memory-anchoring.md`).
- **Portable memory** — export and import the whole memory store as a portable artifact (no lock-in, survives machine/project moves).
- **Visual graph UI** — a localhost interface to explore the agent's memory as an interactive graph.

Explicitly **out of scope** (for now): multi-user/team sharing, image/vision embeddings, heavyweight consolidation tiers we don't need.

## How it works

- Ingests Claude Code / agent session transcripts (e.g. `~/.claude/projects/**/*.jsonl`).
- Local embeddings by default (no rate limits, no cost, offline); pluggable to hosted providers.
- Embedded storage (SQLite + sqlite-vec + FTS5) with hybrid vector + keyword recall.
- Exposed to agents over MCP; explored via the localhost graph UI; distilled via optional LLM consolidation.

## Getting started

Requires **Node ≥ 22**.

```bash
npm install        # install deps (sqlite-vec, transformers.js, MCP SDK)
npm run build      # compile to dist/  (provides the `abs` CLI)
npm run check      # lint → typecheck → test
npm run test:e2e   # opt-in full-system E2E (built binary + MCP + hooks + UI); needs `npx playwright install chromium` once
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
abs consolidate [--session N] [--dry-run] [--force]   # distill a session into durable lessons (opt-in, needs an LLM)
abs install-hooks         # register the Claude Code memory hooks (auto-ingest + context injection) — opt-in, idempotent, backup-first
abs optimize [selector] [--apply] [--yes]   # turn distilled memory into evidence-backed CLAUDE.md / auto-memory diffs (preview → approve → apply)
abs forget [selector] [--apply] [--yes]   # selectively hard-delete memories — IRREVERSIBLE, export first
abs project [--set NAME | --cwd | --skip] [--session ID] [--yes] [--json]   # set/confirm/skip the current session's project
abs --help | --version
```

`abs project` records an intentional project for the **current** Claude Code session
instead of the silent cwd-slug default — the deterministic escape hatch that does not
depend on the agent asking. With no action it prints the resolved session, the auto slug,
existing projects, and suggestions. `--set "NAME"` links an existing project or creates a
new one (sanitized); `--cwd` accepts the cwd-derived slug; `--skip` excludes the session
from memory. The session id comes from `CLAUDE_CODE_SESSION_ID` (or `--session ID` to
override). The decision is applied at the next ingest. `--skip` hard-deletes any
already-stored observations for the session, so that path requires `--yes`. Note the
suggestion is the slug for *this exact* cwd — a symlinked or worktree path produces its
own slug.

`abs hook <event>` (event ∈ `session-end | session-start | user-prompt-submit`) is the
internal entry point the registered hooks invoke — it is non-fatal/timeout-bounded and
never blocks a session. You register it with `abs install-hooks`, not by hand.

`abs forget` takes exactly one selector: `--ids a,b,c` (observation ids),
`--session N`, `--project NAME`, `--null-project` (sessions with no project, NOT the
literal `"null"`), or `--search "q" [--limit N]` (FTS keyword recall, no embedding).
It is **preview-only by default** — nothing is deleted without `--apply`, which prompts
per id `[y/N]` (or pass `--yes` to skip prompts). Hard-delete is irreversible and has no
backup: run `abs export <path>` first. See `docs/adr/0008-hard-delete-safety.md`.

(During development, run any command without building via `npm run dev -- <command>`.)

### LLM consolidation

`abs consolidate` distills a session's raw turns into 3–5 durable **lessons/decisions**,
stored as first-class observations that recall surfaces alongside (and above the noise of)
raw chatter. It is **opt-in and off by default** — it only runs when an LLM endpoint is
configured (`ABS_LLM_BASE_URL` + `ABS_LLM_MODEL`), so the default install stays $0/offline.

```bash
# point at any OpenAI-compatible endpoint — local (Ollama/llama.cpp/LM Studio/vLLM) or hosted
export ABS_LLM_BASE_URL=http://localhost:11434/v1   # e.g. Ollama
export ABS_LLM_MODEL=llama3.1
abs consolidate --dry-run     # preview the distilled lessons (1 LLM call, writes nothing)
abs consolidate               # distill the most recent un-consolidated session
abs consolidate --session 5   # a specific session  ·  --force re-distills (replaces)
```

It is idempotent (a consolidated session is skipped unless `--force`), writes nothing on
error, and contains untrusted transcript content to a strict lesson/decision schema. See
`docs/adr/0003-optional-llm-consolidation.md`.

### Memory graph UI

`abs ui` starts a localhost server (default port `7717`, override with `--port`) and
opens a browser to a force-directed graph of the live store: session hubs and their
observations, colored by kind, with optional similarity edges (`?similarity=1`). It
binds to `127.0.0.1` only and ships self-contained (no CDN — works offline). The default
view is scoped to the most recently active session; switch sessions or use top-N from
the on-canvas controls. Visual intent is documented in `docs/DESIGN.md`.

The UI also offers **selective delete** (preview → confirm → execute, mirroring the CLI
two-phase contract): click a node to delete one observation or a whole session from the
inspector, or run a search and use "excluir busca" to delete the previewed (capped) set.
Deletes are guarded by the localhost CSRF/Origin controls — every delete call carries a
per-process token and the server rejects cross-origin requests; see
`docs/adr/0007-ui-write-path-security.md`. Hard-delete is irreversible
(`docs/adr/0008-hard-delete-safety.md`) — export first.

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

Then ingest your history (`abs ingest`) and Claude Code can call the MCP tools:
`recall`, `remember`, `memory_status`, `optimize`/`apply` (gated memory edits), and
`forget_preview`/`forget` (selective hard-delete — `forget_preview` resolves what a
delete would remove and mints a single-use handle, read-only; `forget` consumes that
handle to delete exactly the previewed set, and is IRREVERSIBLE), and `set_session_project`
(record the current session's project — `action=set|skip`; #52). Configure a hosted
embedder if you prefer (`ABS_EMBED_PROVIDER=gemini|voyage` with the matching API key) —
local stays the default.

### Embedding providers & environment

| Env | Default | Purpose |
| --- | --- | --- |
| `ABS_DB_PATH` / `ABS_HOME` | `~/.agentbrainsystem/memory.db` | where the store lives |
| `ABS_EMBED_PROVIDER` | `local` | `local` \| `gemini` \| `voyage` |
| `ABS_EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | model id for the provider |
| `ABS_EMBED_DIM` | per provider (local 384, gemini 768, voyage 1024) | vector width; only set to override |
| `ABS_RECALL_SCOPE` | `project` | recall/injection isolation: `project` (only the current session's project) \| `global` (store-wide) |
| `ABS_GUARD_MODE` | `warn` | PreToolUse guard: `warn` (surface only) \| `block` (blocks code duplication; decision surfacing stays warn-only) |
| `ABS_LLM_BASE_URL` | _(unset → consolidation off)_ | OpenAI-compatible chat endpoint for `abs consolidate`, e.g. `http://localhost:11434/v1` |
| `ABS_LLM_MODEL` | _(required when base set)_ | chat model id, e.g. `llama3.1` |
| `ABS_LLM_API_KEY` | _(optional)_ | bearer token for hosted endpoints; local backends need none |
| `ABS_LLM_TIMEOUT_MS` | `60000` | per-request timeout for the LLM call |
| `ABS_LLM_PRICE_PER_1K` | _(optional)_ | $ per 1k tokens; only set to get a cost line in consolidate output |

Hosted providers retry transient failures — HTTP `429`/`503` and network errors — with
capped exponential backoff + jitter, honoring `Retry-After`. A momentary rate-limit or
blip during bulk ingest is absorbed instead of aborting the whole run (the local provider
needs none of this — no network).

See also:

- `docs/agent-handbook.md` — onboarding for AI agents and contributors
- `docs/adr/0001-storage-and-embeddings.md` — storage/embedding decisions
- `docs/adr/0002-ui-build-pipeline-and-frontend-stack.md` — UI build pipeline & frontend stack
- `docs/adr/0003-optional-llm-consolidation.md` — optional LLM consolidation & chat provider
- `docs/adr/0004-hook-integration-model.md` — Claude Code hook model (non-fatal/timeout, settings.json ownership)
- `docs/adr/0005-per-prompt-injection-performance.md` — FTS-first per-prompt injection (latency baseline)
- `docs/adr/0006-gated-apply-write-safety.md` — gated-apply safety (backup/atomic/rollback, fail-closed guard)
- `docs/adr/0007-ui-write-path-security.md` — UI write-path security (CSRF/Origin, handle confirmation)
- `docs/adr/0008-hard-delete-safety.md` — hard-delete safety (preview→pin→execute, no-undo)
- `docs/adr/0009-verifiable-memory-anchoring.md` — verifiable memory (code-grounded anchors, self-healing, PreToolUse guard)
- `docs/adr/0010-intentional-session-project-binding.md` — intentional session→project binding (decision-aware ingest feeding project-scoped recall)
- `docs/DESIGN.md` — visual identity for the graph UI
- `docs/export-format.md` — the export artifact format
- [GitHub Issues](https://github.com/victorbjuliani/agentbrainsystem/issues) — requirements and roadmap (source of truth)

## License

See [`LICENSE`](LICENSE).
