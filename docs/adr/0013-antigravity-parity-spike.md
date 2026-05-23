# ADR 0013 — Antigravity CLI (`agy`) memory-parity spike

**Status:** accepted (spike) · **Date:** 2026-05-23 · Issue: #71 · Feeds: #73
(Antigravity adapter) · Related: ADR-0004 (hook integration model), ADR-0010
(intentional session→project binding), the multi-harness spikes (#75)

## Context

We want to know whether the Antigravity CLI — `agy`, the Gemini-CLI successor,
home dir `~/.gemini/` — can host the FULL Agent Brain System memory loop the way
Claude Code, Codex, Copilot, and OpenCode do. "Full parity" means all four
pillars: (1) an automatic CAPTURE trigger on a session lifecycle event, (2) an
automatic RECALL injection mechanism, (3) MCP stdio tools, and (4) a stable
session id paired with a transcript we can read off disk and ingest with a
durable cursor.

The earlier desk research (recorded in #71) made several guesses that the real
install **contradicts**. Those guesses were: hook events
`PreInvocation/PostInvocation/Stop` with no `SessionStart/SessionEnd`; transcript
at `<workspace>/.gemini/jetski/transcript.jsonl` as append-only JSONL; MCP at
`~/.gemini/antigravity-cli/mcp_config.json`. This ADR records what `agy` v1.0.1
actually does, verified by probing the installed binary
(`~/.local/bin/agy`, Mach-O arm64, single Go binary) and `~/.gemini/` on disk.

The verification method matters because no CLI subcommand exposes hooks or MCP in
v1.0.1 (`agy mcp`, `agy hooks` → "unknown subcommand"; the only subcommands are
`changelog`, `help`, `install`, `plugin`/`plugins`, `update`). So the evidence is
(a) symbol/struct-tag and format-string extraction from the binary, which embeds
Go protobuf reflection tags and the jetski source paths, and (b) the on-disk
layout under `~/.gemini/`. `agy` is a thin terminal front-end to the Antigravity
IDE backend ("jetski"); it speaks Connect/gRPC protobuf to that backend rather
than reading flat config files the way Claude Code does.

## The four-pillar findings

### Pillar 1 — automatic CAPTURE trigger: PRESENT

The binary embeds a real JSON-hook system. Format strings:
`failed to parse hooks.json at %s: %v`, `loaded %d named hooks from %d
hooks.json file(s)`, and `Loaded hooks.json from %s: %d named hooks, %d total
handlers`. The hook machinery lives in
`google3/third_party/jetski/cortex/customization/hooks/...` with a
`jsonhook.JSONHookSpec` type and a `backend.HooksFile` loader. The discoverable
JSON hook event names embedded in the binary are exactly:

```
PreToolUse   PostToolUse   SessionStart   SessionEnd   Notification
```

So — correcting the earlier research — `agy` **does** have `SessionStart` and
`SessionEnd`. There is **no** `UserPromptSubmit`, no `Stop`, no `SubagentStop`,
no `PreCompact`. (The protobuf data model additionally carries internal
`pre_tool_hooks`, `stop_hook_args`, and `Pre/PostInvocationHookResult` types used
by the agent loop, but the user-configurable `hooks.json` surface is the five
events above.) Capture maps cleanly to **`SessionEnd`** — the same event ABS
already rides on Claude Code (ADR-0004/0010), so the per-turn re-ingest dup class
that `Stop` would have introduced does not arise here.

Evidence paths: `customizations/hooks`, `customizations/mcp`,
`customizations/skills`, `customizations/agents`, `.agents/`, `.agents/skills/`
(customization discovery roots, extracted from the binary symbol table).

### Pillar 2 — automatic RECALL injection mechanism: PRESENT

The hook result protos carry an injection channel. Extracted struct tag:

```
InjectSteps []*hooks_go_proto.HookInjectedStep
  `protobuf:"bytes,1,rep,name=inject_steps,json=injectSteps,proto3"`
```

with `PreInvocationHookResult.GetInjectSteps` and
`PostInvocationHookResult.GetInjectSteps`, and a source file
`third_party/jetski/cortex/customization/hooks/inject_steps.go` plus
`hookcaller.callHookAs[...]PreInvocationHookResult`. A hook can therefore return
`inject_steps` that the agent loop splices into the conversation — this is the
recall-injection primitive. The natural mapping is the **first-invocation
hook per conversation** (the jetski `PreInvocationHook`), which is exactly how
recall must work, because — see Pillar 4 — there is no
"`SessionStart` carries a user prompt" semantics to attach a one-shot recall to.

### Pillar 3 — MCP stdio tools: PRESENT (file-based register, not a CLI verb)

The binary links a full MCP client: `mcp.Tool`, `mcp.Session`, `mcp.Content`,
`mcp.Request`, `mcp.pipeRWC` (the stdio pipe transport), `PROTOCOL_MCP`,
`McpServerSpec`, `McpServerStatus`, `gemini.GeminiMCPServerConfig`, and IDE RPCs
`ToggleMcpServer`, `GetMcpServerStates`, `DisconnectMcpOAuth`, `ListMcpPrompts`.
The config file is `mcp_config.json` — present on disk at
`~/.gemini/config/mcp_config.json` (currently **0 bytes / empty** on this
install) — and the binary also references a `customizations/mcp` loader and the
log line `MCP manager is nil, cannot load explicit servers`.

Crucially there is **no `agy mcp add` CLI verb** in v1.0.1. Registration is
**file-based**: write the server entry into `mcp_config.json` (the
`GeminiMCPServerConfig` shape — `command` + `args` + `env` for stdio, the same
family as Gemini-CLI / Claude `mcpServers`). This is the OpenCode pattern (a file
writer), not the Claude `claude mcp add` shell-out pattern. The IDE
`ToggleMcpServer` RPC is an enable/disable toggle over already-declared servers,
not an external registration entry point.

### Pillar 4 — stable session id + readable transcript on disk: SESSION ID YES, READABLE TRANSCRIPT **NO**

This is the pillar that fails, and it is the decisive one.

- **Session id: stable and present.** The conversation is identified by a UUID.
  The binary carries `conversation` / `CascadeConversationTitle` protobuf fields,
  the `--conversation <id>` and `--continue` CLI flags, and print mode logs
  `Print mode: resuming conversation %s` and `Sending user message to
  conversation %s (items=%d, media=%d)`. An implicit-context file on disk is
  named by exactly such a UUID:
  `~/.gemini/antigravity-ide/implicit/4b501f35-45cd-4591-b741-be7788fcefbb.pb`.

- **Transcript: NOT a readable file.** There is **no `transcript.jsonl`** and
  **no `jetski/` directory anywhere** (`find / -name transcript.jsonl` and
  `find / -type d -name jetski` both empty). Conversations are persisted as
  **opaque protobuf** managed by the jetski backend: `jetbox_state.pb`,
  `jetbox_state_pb.*` types, `last_step_index`, `Rewinding conversation %s to
  step %d`, and the log `failed to persist last conversation to cache: %v`. The
  on-disk conversation/brain directories
  (`~/.gemini/antigravity-ide/conversations/`, `.../brain/`) are **empty** on a
  freshly-used install; the one artifact that exists (`implicit/<uuid>.pb`) is a
  binary protobuf blob (581 bytes, not text), confirmed by `strings` returning
  only protobuf framing, no message text.

- **Worse: `agy` is gated behind Google OAuth.** A non-interactive
  `agy -p "..."` prints an `accounts.google.com` consent URL and times out
  ("Print mode: silent auth failed, triggering OAuth") without writing any
  conversation. Even the protobuf state is not produced until the user signs in
  with a Google account, and the conversation history is intended to round-trip
  through Google's backend (`PredictionService`, `CloudCode`, `JETSKI_OAUTH_TOKEN`).

So ABS cannot tail an `agy` conversation the way it tails Claude/Codex/Copilot
JSONL. There is no append-only text transcript to cursor over, and the only
on-disk record is an undocumented, version-unstable protobuf
(`jetbox_state.pb`) we would have to reverse-engineer and re-parse on every
backend update — precisely the fragile coupling that bit #67/#68/#69.

## Decision / Verdict

**VERDICT: DOES-NOT-QUALIFY (for FULL parity).** Three of four pillars are
present (capture via `SessionEnd`, recall via `inject_steps`, MCP via
`mcp_config.json`). The fourth fails: **there is no readable transcript on disk**
— conversations live in opaque jetski protobuf (`jetbox_state.pb`) gated behind
Google OAuth, with no JSONL and no documented schema. The capture pillar is only
"present" in the sense that a `SessionEnd` hook can *fire*; it has **nothing
local and readable to ingest**, because the message content is not on disk in any
form ABS can parse. A hook that fires but cannot read the conversation is not a
capture pillar.

This is a hard blocker, not a caveat, because the entire ABS ingest model is
"tail a transcript file with a durable cursor." Antigravity offers no such file.

### What would change the verdict

Antigravity would qualify if any one of these becomes true and is verified:
1. `agy` gains a documented, stable, **readable** transcript export (JSONL or a
   versioned protobuf with a published schema) written to a predictable local
   path; **or**
2. a hook payload (`SessionEnd` / `PreInvocation`) is confirmed to carry the full
   turn content as stdin JSON — making the hook itself the transcript source, so
   ABS never touches `jetbox_state.pb`; **or**
3. the MCP `remember` tool is wired so the agent *pushes* observations to ABS at
   capture time (agent-driven capture), sidestepping the need to read a transcript
   at all. This is the most promising path and is the recommended #73 direction
   if Antigravity support is pursued.

Until one of those is verified on a real install, #73 should **not** ship an
Antigravity transcript-ingest adapter.

## If/when it qualifies — design notes for #73

These are recorded now so #73 does not re-derive them, contingent on the
transcript blocker being resolved by one of the three routes above.

- **Event map.** Capture → **`SessionEnd`** hook (one-shot per session, matches
  ADR-0004; avoids the per-turn `Stop` re-ingest dup class — `Stop` does not
  exist here anyway). Recall → **first `PreInvocation` hook per `conversationId`**,
  returning `inject_steps`; it must be **idempotent and store-tracked** because
  there is no "once at session start with a prompt" event. Guard → **`PreToolUse`**
  hook (e.g. a destructive-write confirmation, mirroring ADR-0010's reverted hard
  gate — keep it a soft notice).
- **The #73 design crux — idempotent first-`PreInvocation` recall.** Antigravity
  has no Claude-style `UserPromptSubmit`/`SessionStart`-with-prompt event to hang
  a single recall on. `PreInvocation` fires **per invocation/turn**, so a naive
  recall would re-inject every turn. The adapter must track, per `conversationId`,
  whether recall has already been injected this conversation (a `kv_meta`-style
  flag, exactly like ADR-0010's `session-project:<id>` binding) and inject only on
  the first `PreInvocation`. This is the central correctness obligation.
- **Transcript format/path/schema (as found, for whoever resolves the blocker).**
  Format = opaque protobuf, not JSONL. Path = `~/.gemini/antigravity-ide/` —
  `implicit/<conversationId>.pb` for implicit context, and `jetbox_state.pb`
  (`jetbox_state_pb.JetboxAppState` / `Projects` / `State`) for app/conversation
  state; `conversations/` and `brain/` are the intended per-conversation homes
  (empty on this install). No human-readable per-message envelope exists on disk;
  message text round-trips through Google's `PredictionService`. There is no
  per-message JSON sample to give because none is written as text.
- **Cursor model.** **Neither a byte cursor nor a clean watermark.** The closest
  watermark is `last_step_index` / "Rewinding conversation to step N" inside the
  protobuf — a step counter, not a byte offset and not an append-only log. A
  byte cursor (Codex/Copilot model) is impossible because there is no text log to
  append to; the protobuf is whole-state and rewritten. If a future readable
  export exists, the cursor model would follow that export's shape — if it is
  JSONL, byte-cursor; if it is the protobuf step model, an `last_step_index`
  watermark per `conversationId`. **Get this right at adapter time** — it is the
  exact bug class (#67/#68/#69) that punishes a wrong cursor assumption.
- **Session-id source.** `conversationId` (UUID), available via the hook payload
  and as the `implicit/<uuid>.pb` filename and `--conversation` flag.
- **MCP register method.** **File-based**, not a CLI verb: write the
  `GeminiMCPServerConfig` stdio entry (`command`/`args`/`env`) into
  `~/.gemini/config/mcp_config.json` (the OpenCode-style file-writer pattern, not
  the Claude `mcp add` shell-out). `agy plugin import` can also pull MCP/extension
  config from an existing `gemini`/`claude` install.
- **Namespace tag.** Use **`antigravity:`** (the product name; `agy:` is the
  binary alias and reads cryptically in stored observations). Matches the
  one-word product-name convention of the other harness tags.

## Alternatives considered

- **Reverse-engineer `jetbox_state.pb` and ingest the protobuf directly.**
  Rejected: undocumented, version-unstable (a backend update silently changes the
  wire shape), OAuth-gated, and exactly the brittle coupling ADRs warn against. A
  protobuf with no published schema is not a parity-grade transcript source.
- **Poll the Google backend for conversation history.** Rejected: requires the
  user's OAuth token, network round-trips on every ingest, and turns a local,
  offline-friendly memory loop into a cloud dependency — counter to the project's
  storage/embeddings posture (ADR-0001).
- **Ship capture-only via `SessionEnd` now, accept no real content.** Rejected: a
  `SessionEnd` hook with nothing readable to ingest stores empty/degenerate
  sessions — worse than no adapter.
