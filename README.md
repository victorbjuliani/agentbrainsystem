# agentbrainsystem

Local-first persistent memory for AI coding agents — capture, store, and **actually recall** past sessions, with portable export/import and a visual graph UI.

> Status: **greenfield / prototype**. Architecture is being finalized via the discovery workflow (see `docs/discovery/`).

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

Setup and commands will be documented here once the stack is finalized. Until then, see:

- `docs/agent-handbook.md` — onboarding for AI agents and contributors
- `docs/engineering-workflow.md` — how work flows here
- [GitHub Issues](https://github.com/victorbjuliani/agentbrainsystem/issues) — requirements and roadmap (source of truth)

## License

See [`LICENSE`](LICENSE).
