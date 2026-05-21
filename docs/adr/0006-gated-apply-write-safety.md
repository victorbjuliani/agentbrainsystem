# ADR 0006 — Gated apply: write safety for CLAUDE.md + auto-memory

**Status:** accepted · **Date:** 2026-05-20 · Depends on: #12 (consolidation), #18
(optimize candidate generation)

## Context

The optimize engine (#18) turns the consolidated lessons/decisions from #12 into
**evidence-backed candidate diffs** and writes nothing. Issue #20 adds the other
half: actually applying an approved candidate to the user's REAL files. This is the
highest-blast-radius code in the project — it edits a project's `CLAUDE.md` (loaded
into every Claude Code session) and Claude Code **auto-memory** entries
(`~/.claude/projects/<slug>/memory/*.md`). A wrong write here corrupts the user's
durable instructions or memory. Some auto-memory entries are the user's own voice
(`metadata.type: user | feedback`) and must never be machine-edited.

The interactive per-candidate approval UX belongs to the converge step (#21); #20's
contract is narrower and safer: **apply receives exactly one already-approved
candidate** and guarantees that applying it is safe or refuses explicitly.

## Decision

1. **Per-candidate apply.** `applyCandidate(candidate, options)` applies a SINGLE
   approved candidate. No batching, no "apply all" — each write is an isolated,
   auditable operation with its own safety envelope.

2. **Target allowlist (enforced in code + tested).** A candidate's target is run
   through `resolveTarget`, which recomputes the canonical path for the declared
   KIND and accepts only:
   - the project's root `CLAUDE.md`, or
   - a `*.md` under the project's auto-memory dir
     `<projectsDir>/<slug>/memory/`, where `<slug>` = the absolute project path with
     every `/` replaced by `-` (the Claude Code project slug, identical to the
     encoding the ingest layer reads). The candidate's `absPath` must match
     byte-for-byte; a `..` escape out of the memory dir, a non-markdown file,
     `AGENTS.md`, source code, or any other path is **REFUSED** (`forbidden-target`).
   Restricting to exactly two kinds in code (not by convention) is the primary
   containment: even a malicious candidate cannot direct a write outside them.

3. **Fail-closed `user|feedback` guard (dedicated test file).** Before writing an
   existing auto-memory entry, the applier reads its frontmatter `metadata.type`. If
   it is `user` or `feedback`, the apply is **REFUSED with an explicit
   `protected-memory-type`** — never a silent skip. The guard is conservative: an
   unreadable/absent type on a NEW entry is allowed (the engine only ever creates
   its own `project`-type managed entry), but any existing entry that declares a
   protected type is untouchable. A frontmatter type is read with a tiny
   dependency-free parser (the entries are simple YAML — no YAML dep, keeping the
   module $0/offline).

4. **Backup → atomic write → rollback.** Every edit:
   - copies the original to `<file>.abs-bak-<ts>` (skipped when the file does not
     exist yet — nothing to back up),
   - writes the new content to a temp file in the **same directory**, then `rename`s
     it into place (atomic on one filesystem — readers see old-or-new, never a torn
     write),
   - on ANY failure mid-operation, restores: drop the temp file, restore the backup
     over the target (or remove the target if it did not exist before), and remove
     the backup — leaving the original **byte-for-byte intact**. The mid-write
     failure → file-unchanged path has a dedicated test (a failing `rename` injected
     through a filesystem seam).

5. **Append-only diffs + stale guard.** #18 diffs are append-only (a managed
   section appended to the file's tail), so applying = current content + the
   candidate's proposed block — no rewriting of hand-written lines. The applier
   re-reads the file at apply time; if an `expectedBaseContent` was supplied and the
   file no longer matches it, the apply is REFUSED (`target-modified`) rather than
   clobbering a file edited since the candidate was generated.

6. **One applier, two kinds (not two classes).** The "CLAUDE.md applier" and
   "auto-memory applier" the issue calls for are the two target KINDS a single
   `GatedApplier` resolves and writes with identical safety. Splitting them would
   duplicate the riskiest code (the backup/atomic/rollback envelope) for no benefit.
   The filesystem is injectable (`ApplierFs`) purely so tests can force a mid-write
   failure deterministically.

## Consequences

- **Positive:** the user's real CLAUDE.md / memory can only ever be appended to, in
  exactly two locations, with a backup and an atomic swap; a crash or error never
  leaves a partial write; the user's own `user|feedback` memory is untouchable; a
  stale candidate cannot clobber concurrent edits. Refusals are explicit and
  machine-readable (`forbidden-target`, `protected-memory-type`, `target-modified`)
  so #21 can surface them.
- **Negative / trade-offs:** append-only means the engine cannot revise or remove an
  existing managed bullet — only add (acceptable for a memory layer; revision is a
  future concern). Backups accumulate as `.abs-bak-*` files (left in place so a user
  can recover; cleanup is deferred to #21/ops). Same-filesystem atomicity assumes the
  temp file and target share a device (true for both target kinds).
- **Tested:** allowlist rejection, slug mapping (against temp paths, never the real
  dir), the fail-closed guard (dedicated `guard.test.ts` — refused, not skipped, file
  intact), backup/atomic write, and the mid-write-failure → file-unchanged rollback.
  **Untested by design:** none of the safety paths — they are all covered against
  `os.tmpdir()`; no test ever writes to a real `~/.claude` or a real `CLAUDE.md`.

## Known follow-ups / accepted residual risk

A white-box audit of the live memory layer (#15–#21) surfaced two findings we are
**deliberately not fixing now**. Both are recorded here as accepted residual risk
with a tracked follow-up; neither is a blocking issue given the existing backstops.

- **MCP `optimize` `project` arg is agent-controlled** (`mcp/server.ts`). The
  `optimize` tool takes an optional `project` root from the calling agent, which
  could in principle steer a candidate's target at an arbitrary project path.
  **Accepted residual:** the trust boundary is the human, not the agent — every
  `apply` is approved per-candidate by a person, and the resolved absolute target is
  visible both in the `optimize` candidate (`target.path`) and in the `ApplyResult`
  (`absPath`), so a misdirected write is observable before and after. The two-kind
  allowlist (`resolveTarget`) still confines any write to a CLAUDE.md or an
  auto-memory `*.md` under the *declared* project's slug dir. **Follow-up:** consider
  pinning the optimize/apply target to the server's launch cwd rather than trusting
  the agent-supplied `project`.

- **Project slug collision** (`targets.ts` `projectSlug`). The slug encoding maps
  every `/` to `-`, so `/a/b` and `/a-b` collapse to the same auto-memory dir
  (`-a-b`). Two distinct projects could therefore resolve to the same memory
  location. **Not fixed now** because this encoding must stay byte-identical to the
  ingest layer's slug encoding (the allowlist resolves against the same canonical
  path ingest reads); a reversible/collision-free encoding would require changing
  **both** layers together in lockstep. **Follow-up tracked** to migrate both
  encodings simultaneously.

## Alternatives rejected

- **Two separate applier classes (CLAUDE.md vs auto-memory).** Would duplicate the
  backup/atomic/rollback envelope — the exact code that must not drift between two
  copies. One applier + a kind-aware resolver is safer.
- **Silently skipping protected `user|feedback` entries.** A silent skip hides the
  refusal from the caller and the user. An explicit refusal is auditable and lets
  #21 explain why a candidate was not applied.
- **In-place write (truncate + write).** A crash mid-write leaves a truncated file.
  Temp-file + atomic `rename` makes the swap all-or-nothing.
- **Path allowlist by string prefix only.** Resolving + canonicalising the path and
  comparing to the recomputed canonical target defeats `..` traversal and symlink-y
  inputs that a naive `startsWith` would admit.
- **A YAML dependency to read frontmatter.** The frontmatter we read is a trivial
  key/value + one-level `metadata:` block; a 30-line reader keeps the module
  $0/offline and dependency-light, consistent with the rest of the project.
