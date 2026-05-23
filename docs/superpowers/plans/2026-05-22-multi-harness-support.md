# Multi-harness Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `abs` deliver full memory parity (auto-capture + auto-recall + MCP + session id) across multiple coding harnesses on the same machine, starting by refactoring the Claude-Code-only code behind a harness-adapter contract.

**Architecture:** A public `HarnessAdapter` contract implemented by composition of reusable capability modules (`TranscriptSource`, `LifecycleInstaller`, `SessionResolver`, `ContextInjector`, `McpRegistrar`). A single canonical `Observation`/`SessionRecord` shape keeps the **core** (`src/store`, `src/recall`, `src/embedding`, `src/optimize`) harness-agnostic. The `LifecycleInstaller` is parametrized by a map from a harness's native lifecycle events to ~3 canonical moments (`capture`/`recall`/`guard`), never hardcoded to Claude Code's event names. Claude Code becomes the reference adapter; its existing test suite is the regression gate proving the abstraction did not leak.

**Tech Stack:** Node ≥ 22, TypeScript (ESM), Vitest, Biome, embedded SQLite via `better-sqlite3` (synchronous). Source-of-truth design doc: `docs/superpowers/specs/2026-05-22-multi-harness-support-design.md`.

---

## Ground truth (verified against the codebase — read before starting)

These facts were confirmed by reading the code and **correct earlier misconceptions**:

- **The hook path already reads the session id from the payload, not an env var.** `parseHookPayload` (`src/hooks/payload.ts:54-57`) reads `session_id` + `transcript_path` from the stdin JSON generically; handlers use `payload.sessionId` (`session-start.ts`) / `payload.transcriptPath` (`session-end.ts`). `dispatchHook` (`src/hooks/dispatch.ts:42-50`) reads no env var. So the hook capture/recall path is **already harness-agnostic at the payload level** — the harness-specific parts are only (a) the native event *names* (settings file format) and (b) the transcript *format*.
- **`CLAUDE_CODE_SESSION_ID` is read in exactly two non-hook places:** `src/cli/cli.ts:816` (`resolveSessionId`, for `abs project`) and `src/mcp/server.ts:93` and `:446` (MCP tool fallback). These are the only env-coupled session-id sites; Task 9 centralizes them behind the adapter.
- **The CLI commands are `abs install-hooks` (`cli.ts:376` `cmdInstallHooks`) and `abs setup` (`cli.ts:422` `cmdSetup`).** There is no `abs install`. `cmdSetup` does hooks **and** MCP registration (`registerMcpServer(cliPath, spawnCapture)`, `cli.ts:428`); `cmdInstallHooks` does hooks only. `cmdUninstall` (around `cli.ts:497`) calls `uninstallHooks()` + `unregisterMcpServer(spawnCapture)`.
- **The store is `better-sqlite3` and synchronous.** Opened via `new MemoryStore({ dbPath, dimensions }).open()` (`src/store/memory-store.ts:130-154`); `dimensions` is **mandatory** (`StoreOptions`, `src/store/types.ts:10-14`). `setMeta`/`getMeta` are synchronous methods. **WAL is already enabled** at `memory-store.ts:149`; `foreign_keys = ON` at `:150`. Only `busy_timeout` is a genuinely new pragma.
- **`installHooks` derives the hook command from its own `HOOK_REGISTRY`** (`installer.ts:65, 198-199`: `command = ${baseCommand} ${spec.eventArg}`), keyed by `HookEvent`. A capability that wants different per-event CLI args for a *different* harness must generalize `installHooks` — that is **Phase 1 (Codex) work**, not Phase 0. In Phase 0 the capability passes only the `events` subset.
- **Real uninstall/unregister exist:** `uninstallHooks()` returns `{ removed: HookEvent[] }` (`installer.ts:249-253`); `unregisterMcpServer(run)` (`setup.ts:94`). The adapter must delegate to these, not stub them.

## Scope note

This plan covers **Phase 0 (the adapter refactor)** task-by-task — the foundation every harness depends on, shipping working software on its own (Claude Code keeps working, now through the contract). Phases 1–3 (per-harness adapters and spikes) are scoped as **follow-on work items** at the end; each gets its own detailed plan when scheduled, because writing bite-sized code for harnesses whose transcript schema is unvalidated (OpenCode, Antigravity CLI, Grok Build) would be fabrication.

## File structure (Phase 0)

New directory `src/harness/` owns all harness-aware code:

- Create `src/harness/types.ts` — `HarnessAdapter` contract, `LifecycleMoment` union, capability interfaces, and neutral `RunFn`/`RunResult` types (declared locally so `src/harness` does not depend on `src/cli` for types).
- Create `src/harness/registry.ts` — registers adapters, lists, detects installed, resolves by id.
- Create `src/harness/capabilities/session-resolver.ts` — `SessionResolver` + `payloadFirstResolver` (payload first, optional env-var override).
- Create `src/harness/capabilities/lifecycle-installer.ts` — `LifecycleInstaller` + `settingsFileInstaller` (wraps `installHooks`, takes the `events` subset).
- Create `src/harness/capabilities/transcript-source.ts` — `TranscriptSource` + `jsonlTranscriptSource` (wraps `ingestSingleSession`).
- Create `src/harness/capabilities/mcp-registrar.ts` — `McpRegistrar` + `cliMcpRegistrar` (wraps `registerMcpServer`; `run` passed at call time).
- Create `src/harness/capabilities/context-injector.ts` — `ContextInjector` + `stdoutInjector` (wraps `buildContextOutput`).
- Create `src/harness/adapters/claude-code.ts` — the reference adapter; **real** `install`/`uninstall`/`registerMcp`/`resolveSession` (no stubs).
- Create `src/harness/index.ts` — `defaultRegistry()`.
- Modify `src/cli/cli.ts` — `cmdInstallHooks` / `cmdSetup` / `cmdUninstall` route through the adapter; `resolveSessionId` (`:808`) delegates env reads to the Claude adapter; add `--harness <id>` + auto-detect.
- Modify `src/mcp/server.ts` — the two `CLAUDE_CODE_SESSION_ID` fallbacks (`:93`, `:446`) delegate to the Claude adapter's resolver.
- Modify `src/store/memory-store.ts` — add `busy_timeout` pragma next to the existing WAL pragma (`:149`).

The core (`src/store`, `src/recall`, `src/embedding`, `src/optimize`) is **not** modified except the one pragma line, and must never `import` from `src/harness`. Existing modules in `src/hooks`, `src/ingest`, `src/cli/setup.ts` keep their logic — the capabilities **wrap** them; nothing is rewritten in Phase 0.

---

## Task 1: Canonical adapter contract + capability-neutral types

**Files:**
- Create: `src/harness/types.ts`
- Test: `src/harness/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/harness/types.test.ts
import { describe, expect, it } from 'vitest';
import type { HarnessAdapter, LifecycleMoment } from './types.js';

describe('HarnessAdapter contract', () => {
  it('a minimal fake adapter satisfies the contract', () => {
    const fake: HarnessAdapter = {
      id: 'fake',
      displayName: 'Fake',
      detect: async () => false,
      qualifies: () => ({ ok: true, missing: [] }),
      eventMap: { capture: ['Stop'], recall: ['PreInvocation'], guard: ['PreToolUse'] },
      install: async () => ({ wired: [] }),
      uninstall: async () => ({ removed: [] }),
      registerMcp: async () => ({ status: 'already' }),
      resolveSession: () => ({ sessionId: 'abc' }),
    };
    expect(fake.id).toBe('fake');
  });

  it('lifecycle moments are exactly capture | recall | guard', () => {
    const moments: LifecycleMoment[] = ['capture', 'recall', 'guard'];
    expect(moments).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/harness/types.test.ts`
Expected: FAIL — `Cannot find module './types.js'`.

- [ ] **Step 3: Write the contract**

```typescript
// src/harness/types.ts
/**
 * The harness-adapter contract (multi-harness support).
 *
 * Every harness-aware concern lives behind this contract; the core
 * (store / recall / embedding / optimize) never names a harness. An adapter MAPS
 * its harness's native lifecycle events to ~3 canonical moments, so the installer
 * is never hardcoded to one harness's event vocabulary.
 */

/** The canonical lifecycle moments `abs` cares about, regardless of harness. */
export type LifecycleMoment = 'capture' | 'recall' | 'guard';

/** A harness's native event names mapped onto the canonical moments. */
export type EventMap = Record<LifecycleMoment, readonly string[]>;

/** The four parity pillars; an empty `missing` array means the harness qualifies. */
export interface QualifyResult {
  ok: boolean;
  missing: readonly ('capture' | 'recall' | 'mcp' | 'session-id')[];
}

/** Session identity (+ transcript location) for one live session. */
export interface SessionIdentity {
  sessionId: string;
  transcriptPath?: string;
}

/** The minimal input an adapter needs to resolve a session (harness-agnostic). */
export interface ResolveInput {
  payload?: { sessionId?: string; transcriptPath?: string };
  env?: NodeJS.ProcessEnv;
}

export interface InstallReport {
  wired: readonly LifecycleMoment[];
}
export interface UninstallReport {
  removed: readonly LifecycleMoment[];
}

/** Process-spawn result — declared locally so `src/harness` needs no `src/cli` type import. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Structurally compatible with `src/cli/setup.ts`'s `RunFn`. */
export type RunFn = (cmd: string, args: string[]) => Promise<RunResult>;

/** Normalized MCP registration outcome shared by all adapters. */
export type McpRegisterStatus =
  | { status: 'registered' }
  | { status: 'already' }
  | { status: 'unavailable'; manualCommand: string }
  | { status: 'error'; message: string; manualCommand: string };

export interface HarnessAdapter {
  id: string;
  displayName: string;
  /** Is this harness installed on the current machine? Never throws. */
  detect(): Promise<boolean>;
  /** The parity gate — does this harness expose all four pillars? */
  qualifies(): QualifyResult;
  /** Native-event → canonical-moment map. */
  eventMap: EventMap;
  /** Wire the lifecycle (idempotent, backup-first). */
  install(): Promise<InstallReport>;
  /** Remove the lifecycle wiring. */
  uninstall(): Promise<UninstallReport>;
  /** Register the MCP server. `run` is injected by the CLI (no harness→cli coupling). */
  registerMcp(cliPath: string, run: RunFn): Promise<McpRegisterStatus>;
  /** Resolve the session id (+ transcript path) for the current moment. */
  resolveSession(input: ResolveInput): SessionIdentity | null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/harness/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/types.ts src/harness/types.test.ts
git commit -m "feat(harness): canonical HarnessAdapter contract + neutral run types"
```

---

## Task 2: Adapter registry

**Files:**
- Create: `src/harness/registry.ts`
- Test: `src/harness/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/harness/registry.test.ts
import { describe, expect, it } from 'vitest';
import { createRegistry } from './registry.js';
import type { HarnessAdapter } from './types.js';

function fakeAdapter(id: string, installed: boolean): HarnessAdapter {
  return {
    id,
    displayName: id,
    detect: async () => installed,
    qualifies: () => ({ ok: true, missing: [] }),
    eventMap: { capture: [], recall: [], guard: [] },
    install: async () => ({ wired: [] }),
    uninstall: async () => ({ removed: [] }),
    registerMcp: async () => ({ status: 'already' }),
    resolveSession: () => null,
  };
}

describe('createRegistry', () => {
  it('resolves a registered adapter by id', () => {
    const reg = createRegistry([fakeAdapter('a', true), fakeAdapter('b', false)]);
    expect(reg.byId('a')?.id).toBe('a');
    expect(reg.byId('missing')).toBeUndefined();
  });

  it('lists only installed adapters via detectInstalled', async () => {
    const reg = createRegistry([fakeAdapter('a', true), fakeAdapter('b', false)]);
    const installed = await reg.detectInstalled();
    expect(installed.map((x) => x.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/harness/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the registry**

```typescript
// src/harness/registry.ts
import type { HarnessAdapter } from './types.js';

export interface HarnessRegistry {
  all(): readonly HarnessAdapter[];
  byId(id: string): HarnessAdapter | undefined;
  detectInstalled(): Promise<HarnessAdapter[]>;
}

export function createRegistry(adapters: readonly HarnessAdapter[]): HarnessRegistry {
  const byIdMap = new Map(adapters.map((a) => [a.id, a]));
  return {
    all: () => adapters,
    byId: (id) => byIdMap.get(id),
    detectInstalled: async () => {
      const flags = await Promise.all(adapters.map((a) => a.detect().catch(() => false)));
      return adapters.filter((_, i) => flags[i]);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/harness/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/registry.ts src/harness/registry.test.ts
git commit -m "feat(harness): adapter registry with detectInstalled"
```

---

## Task 3: SessionResolver capability (payload-first, env-var override)

**Files:**
- Create: `src/harness/capabilities/session-resolver.ts`
- Test: `src/harness/capabilities/session-resolver.test.ts`

The hook path already reads the id from the payload. This capability is the canonical resolver consumed by the **two non-hook env sites** (`cli.ts:resolveSessionId`, `mcp/server.ts`) in Task 9, and by future non-Claude adapters whose payloads carry the id.

- [ ] **Step 1: Write the failing test**

```typescript
// src/harness/capabilities/session-resolver.test.ts
import { describe, expect, it } from 'vitest';
import { payloadFirstResolver } from './session-resolver.js';

describe('payloadFirstResolver', () => {
  it('reads session id + transcript path from the payload', () => {
    const resolve = payloadFirstResolver();
    expect(resolve({ payload: { sessionId: 's1', transcriptPath: '/t.jsonl' } })).toEqual({
      sessionId: 's1',
      transcriptPath: '/t.jsonl',
    });
  });

  it('falls back to an env var when the payload has no id', () => {
    const resolve = payloadFirstResolver({ envVar: 'CLAUDE_CODE_SESSION_ID' });
    expect(resolve({ env: { CLAUDE_CODE_SESSION_ID: 'env-id' } })).toEqual({ sessionId: 'env-id' });
  });

  it('returns null when neither payload nor env yields an id', () => {
    const resolve = payloadFirstResolver({ envVar: 'CLAUDE_CODE_SESSION_ID' });
    expect(resolve({ env: {} })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/harness/capabilities/session-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the resolver**

```typescript
// src/harness/capabilities/session-resolver.ts
import type { ResolveInput, SessionIdentity } from '../types.js';

export interface SessionResolverOptions {
  /** Adapter-specific env var carrying the session id (e.g. Claude Code). */
  envVar?: string;
}

/** Build a resolver that prefers the hook payload, then an optional env var. */
export function payloadFirstResolver(
  options: SessionResolverOptions = {},
): (input: ResolveInput) => SessionIdentity | null {
  return (input) => {
    const fromPayload = input.payload?.sessionId;
    if (fromPayload) {
      const id: SessionIdentity = { sessionId: fromPayload };
      if (input.payload?.transcriptPath) id.transcriptPath = input.payload.transcriptPath;
      return id;
    }
    if (options.envVar) {
      const fromEnv = input.env?.[options.envVar];
      if (fromEnv) return { sessionId: fromEnv };
    }
    return null;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/harness/capabilities/session-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/capabilities/session-resolver.ts src/harness/capabilities/session-resolver.test.ts
git commit -m "feat(harness): payload-first session resolver with env-var override"
```

---

## Task 4: LifecycleInstaller capability (wraps installHooks)

**Files:**
- Create: `src/harness/capabilities/lifecycle-installer.ts`
- Test: `src/harness/capabilities/lifecycle-installer.test.ts`

`installHooks` owns command derivation from `HOOK_REGISTRY`. In Phase 0 the capability takes only the `events` subset (the Claude registry's args already match `abs hook <arg>`). Generalizing per-event CLI args for a different harness is Phase 1 (Codex) work; do **not** add an `eventArgs` map here — it would be dead.

- [ ] **Step 1: Write the failing test** — installing the four Claude events writes the four hook commands and reports the three canonical moments.

```typescript
// src/harness/capabilities/lifecycle-installer.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settingsFileInstaller } from './lifecycle-installer.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-lifecycle-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('settingsFileInstaller (Claude Code shape)', () => {
  it('writes the four canonical hook commands and reports three moments', async () => {
    const settingsPath = join(dir, 'settings.json');
    const installer = settingsFileInstaller({
      settingsPath,
      events: ['SessionEnd', 'SessionStart', 'UserPromptSubmit', 'PreToolUse'],
    });
    const report = await installer.install();
    expect(report.wired.slice().sort()).toEqual(['capture', 'guard', 'recall']);
    const written = JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks);
    expect(written).toContain('abs hook session-end');
    expect(written).toContain('abs hook session-start');
    expect(written).toContain('abs hook user-prompt-submit');
    expect(written).toContain('abs hook pre-tool-use');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/harness/capabilities/lifecycle-installer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the capability**

```typescript
// src/harness/capabilities/lifecycle-installer.ts
import { installHooks, type InstallOptions, uninstallHooks } from '../../hooks/installer.js';
import type { HookEvent } from '../../hooks/payload.js';
import type { InstallReport, LifecycleMoment, UninstallReport } from '../types.js';

/** Which canonical moment each Claude-style native event serves. */
export const CLAUDE_EVENT_MOMENT: Record<HookEvent, LifecycleMoment> = {
  SessionEnd: 'capture',
  SessionStart: 'recall',
  UserPromptSubmit: 'recall',
  PreToolUse: 'guard',
};

function momentsOf(events: readonly HookEvent[]): LifecycleMoment[] {
  return [...new Set(events.map((e) => CLAUDE_EVENT_MOMENT[e]))];
}

export interface SettingsInstallerOptions {
  events: readonly HookEvent[];
  settingsPath?: string;
  baseCommand?: string;
}

export interface LifecycleInstaller {
  install(): Promise<InstallReport>;
  uninstall(): Promise<UninstallReport>;
}

/**
 * Settings-file installer for Claude-style harnesses. Delegates to the existing,
 * battle-tested `installHooks`/`uninstallHooks` (idempotent, backup-first,
 * symlink-refusing). `install` reports the canonical moments wired (derived from
 * the requested events); `uninstall` reports the moments whose hook was removed.
 */
export function settingsFileInstaller(options: SettingsInstallerOptions): LifecycleInstaller {
  const buildOpts = (): InstallOptions => {
    const o: InstallOptions = { events: [...options.events] };
    if (options.settingsPath) o.settingsPath = options.settingsPath;
    if (options.baseCommand) o.baseCommand = options.baseCommand;
    return o;
  };
  return {
    install: async () => {
      installHooks(buildOpts());
      return { wired: momentsOf(options.events) };
    },
    uninstall: async () => {
      const result = uninstallHooks(buildOpts());
      return { removed: momentsOf(result.removed) };
    },
  };
}
```

> NOTE: confirm `uninstallHooks` accepts the same `InstallOptions`-shaped argument (`installer.ts:236` `UninstallOptions`). If its option type differs, pass only the fields it declares; the `events`/`settingsPath`/`baseCommand` subset is what matters.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/harness/capabilities/lifecycle-installer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/capabilities/lifecycle-installer.ts src/harness/capabilities/lifecycle-installer.test.ts
git commit -m "feat(harness): lifecycle installer wrapping installHooks/uninstallHooks"
```

---

## Task 5: TranscriptSource capability (wraps ingestSingleSession)

**Files:**
- Create: `src/harness/capabilities/transcript-source.ts`
- Test: `src/harness/capabilities/transcript-source.test.ts`

The ingest cursor is keyed by absolute transcript path (`ingest:cursor:<absPath>`, `ingest.ts:32,95`), so different harnesses' transcripts (different paths) are already **cursor**-isolated. (Session-row isolation by `external_id` is a separate concern — see W1 deferral note at the end.)

- [ ] **Step 1: Write the failing test**

```typescript
// src/harness/capabilities/transcript-source.test.ts
import { describe, expect, it, vi } from 'vitest';
import { jsonlTranscriptSource } from './transcript-source.js';

describe('jsonlTranscriptSource', () => {
  it('ingests a single transcript via the injected ingester', async () => {
    const ingest = vi.fn(async () => ({
      filesProcessed: 1,
      filesSkipped: 0,
      observationsAdded: 3,
      observationsSkipped: 0,
      anchorsSeeded: 1,
    }));
    const source = jsonlTranscriptSource({ ingestSingle: ingest });
    const result = await source.ingest({} as never, '/abs/transcript.jsonl');
    expect(ingest).toHaveBeenCalledWith({}, '/abs/transcript.jsonl');
    expect(result.observationsAdded).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/harness/capabilities/transcript-source.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the capability**

```typescript
// src/harness/capabilities/transcript-source.ts
import { ingestSingleSession } from '../../ingest/ingest.js';
import type { IngestResult } from '../../ingest/types.js';
import type { Memory } from '../../memory.js';

export interface TranscriptSource {
  ingest(memory: Memory, transcriptPath: string): Promise<IngestResult>;
}

export interface JsonlSourceOptions {
  /** Injection seam for tests; defaults to the real single-session ingester. */
  ingestSingle?: (memory: Memory, transcriptPath: string) => Promise<IngestResult>;
}

/** A JSONL-transcript source — the shape Claude Code, Codex and Copilot all use. */
export function jsonlTranscriptSource(options: JsonlSourceOptions = {}): TranscriptSource {
  const ingest = options.ingestSingle ?? ingestSingleSession;
  return { ingest: (memory, transcriptPath) => ingest(memory, transcriptPath) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/harness/capabilities/transcript-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/capabilities/transcript-source.ts src/harness/capabilities/transcript-source.test.ts
git commit -m "feat(harness): JSONL transcript source wrapping ingestSingleSession"
```

---

## Task 6: McpRegistrar capability (wraps registerMcpServer; run at call time)

**Files:**
- Create: `src/harness/capabilities/mcp-registrar.ts`
- Test: `src/harness/capabilities/mcp-registrar.test.ts`

`run` is supplied at `register(cliPath, run)` call time — the CLI injects its real `spawnCapture` in Task 9, so the harness layer never spawns processes itself.

- [ ] **Step 1: Write the failing test**

```typescript
// src/harness/capabilities/mcp-registrar.test.ts
import { describe, expect, it } from 'vitest';
import { cliMcpRegistrar } from './mcp-registrar.js';

describe('cliMcpRegistrar', () => {
  it('reports "already" when the server is registered', async () => {
    const run = async (_cmd: string, args: string[]) => {
      if (args.includes('--version')) return { code: 0, stdout: 'claude 1', stderr: '' };
      if (args.includes('list')) return { code: 0, stdout: 'agentbrainsystem', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const registrar = cliMcpRegistrar();
    expect(await registrar.register('/path/cli.js', run)).toEqual({ status: 'already' });
  });

  it('maps no-claude to the canonical unavailable status', async () => {
    const run = async () => ({ code: null, stdout: '', stderr: '' });
    const registrar = cliMcpRegistrar();
    expect((await registrar.register('/path/cli.js', run)).status).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/harness/capabilities/mcp-registrar.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the capability**

```typescript
// src/harness/capabilities/mcp-registrar.ts
import { registerMcpServer } from '../../cli/setup.js';
import type { McpRegisterStatus, RunFn } from '../types.js';

export interface McpRegistrar {
  register(cliPath: string, run: RunFn): Promise<McpRegisterStatus>;
}

/** MCP registrar for CLI-driven harnesses (`<cli> mcp add ...`). */
export function cliMcpRegistrar(): McpRegistrar {
  return {
    register: async (cliPath, run) => {
      const result = await registerMcpServer(cliPath, run);
      if (result.status === 'no-claude') {
        return { status: 'unavailable', manualCommand: result.manualCommand };
      }
      return result;
    },
  };
}
```

> NOTE: `registerMcpServer` currently hardcodes the `claude` binary (`setup.ts`). Generalizing it to a configurable binary + `mcp add` argv is **Phase 1 (Codex)** work. In Phase 0 the registrar wraps the existing Claude-only function unchanged. `RunFn` here is the neutral type from `types.ts`, structurally compatible with `setup.ts`'s `RunFn`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/harness/capabilities/mcp-registrar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/capabilities/mcp-registrar.ts src/harness/capabilities/mcp-registrar.test.ts
git commit -m "feat(harness): CLI MCP registrar wrapping registerMcpServer"
```

---

## Task 7: ContextInjector capability (wraps buildContextOutput)

**Files:**
- Create: `src/harness/capabilities/context-injector.ts`
- Test: `src/harness/capabilities/context-injector.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/harness/capabilities/context-injector.test.ts
import { describe, expect, it } from 'vitest';
import { stdoutInjector } from './context-injector.js';

describe('stdoutInjector', () => {
  it('builds the Claude additionalContext JSON line for a recall moment', () => {
    const injector = stdoutInjector();
    const line = injector.render('SessionStart', 'recalled fact');
    expect(line).toContain('"additionalContext":"recalled fact"');
  });

  it('returns null for empty text', () => {
    const injector = stdoutInjector();
    expect(injector.render('SessionStart', '   ')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/harness/capabilities/context-injector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the capability**

```typescript
// src/harness/capabilities/context-injector.ts
import { buildContextOutput, type HookEvent } from '../../hooks/payload.js';

export interface ContextInjector {
  render(event: HookEvent, text: string): string | null;
}

/** Injector for harnesses that read a `hookSpecificOutput.additionalContext` stdout line. */
export function stdoutInjector(): ContextInjector {
  return { render: (event, text) => buildContextOutput(event, text) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/harness/capabilities/context-injector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/capabilities/context-injector.ts src/harness/capabilities/context-injector.test.ts
git commit -m "feat(harness): stdout context injector wrapping buildContextOutput"
```

---

## Task 8: Claude Code reference adapter (real composition, no stubs)

**Files:**
- Create: `src/harness/adapters/claude-code.ts`
- Test: `src/harness/adapters/claude-code.test.ts`

Every method is **real** — `install`/`uninstall` delegate to `settingsFileInstaller`, `registerMcp` delegates to `cliMcpRegistrar`. No method returns a placeholder; Task 9 only wires callers, never replaces a stub.

- [ ] **Step 1: Write the failing test**

```typescript
// src/harness/adapters/claude-code.test.ts
import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from './claude-code.js';

describe('claudeCodeAdapter', () => {
  it('qualifies for full parity', () => {
    expect(claudeCodeAdapter().qualifies()).toEqual({ ok: true, missing: [] });
  });

  it('maps native events to canonical moments', () => {
    const { eventMap } = claudeCodeAdapter();
    expect(eventMap.capture).toContain('SessionEnd');
    expect(eventMap.recall).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit']));
    expect(eventMap.guard).toContain('PreToolUse');
  });

  it('resolves the session id from the payload first, then the env var', () => {
    const adapter = claudeCodeAdapter();
    expect(adapter.resolveSession({ payload: { sessionId: 'p1' } })?.sessionId).toBe('p1');
    expect(adapter.resolveSession({ env: { CLAUDE_CODE_SESSION_ID: 'e1' } })?.sessionId).toBe('e1');
  });

  it('registerMcp delegates to the injected run (reports already)', async () => {
    const run = async (_c: string, args: string[]) =>
      args.includes('--version')
        ? { code: 0, stdout: 'claude', stderr: '' }
        : { code: 0, stdout: 'agentbrainsystem', stderr: '' };
    expect((await claudeCodeAdapter().registerMcp('/cli.js', run)).status).toBe('already');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/harness/adapters/claude-code.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the adapter**

```typescript
// src/harness/adapters/claude-code.ts
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HookEvent } from '../../hooks/payload.js';
import { settingsFileInstaller } from '../capabilities/lifecycle-installer.js';
import { cliMcpRegistrar } from '../capabilities/mcp-registrar.js';
import { payloadFirstResolver } from '../capabilities/session-resolver.js';
import type { HarnessAdapter } from '../types.js';

const CLAUDE_EVENTS: readonly HookEvent[] = [
  'SessionEnd',
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
];

export function claudeCodeAdapter(): HarnessAdapter {
  const resolve = payloadFirstResolver({ envVar: 'CLAUDE_CODE_SESSION_ID' });
  const installer = settingsFileInstaller({ events: CLAUDE_EVENTS });
  const registrar = cliMcpRegistrar();
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    detect: async () => {
      try {
        await access(join(homedir(), '.claude'));
        return true;
      } catch {
        return false;
      }
    },
    qualifies: () => ({ ok: true, missing: [] }),
    eventMap: {
      capture: ['SessionEnd'],
      recall: ['SessionStart', 'UserPromptSubmit'],
      guard: ['PreToolUse'],
    },
    install: () => installer.install(),
    uninstall: () => installer.uninstall(),
    registerMcp: (cliPath, run) => registrar.register(cliPath, run),
    resolveSession: (input) => resolve(input),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/harness/adapters/claude-code.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/adapters/claude-code.ts src/harness/adapters/claude-code.test.ts
git commit -m "feat(harness): Claude Code reference adapter (real composition)"
```

---

## Task 9: Wire CLI + MCP through the adapter (regression gate)

**Files:**
- Create: `src/harness/index.ts`
- Modify: `src/cli/cli.ts` — `cmdInstallHooks`/`cmdSetup`/`cmdUninstall` route through the adapter; `resolveSessionId` (`:808`) delegates env reads to the adapter; add `--harness <id>` + auto-detect.
- Modify: `src/mcp/server.ts` — the two `process.env.CLAUDE_CODE_SESSION_ID` fallbacks (`:93`, `:446`) delegate to the adapter resolver.
- Test: `src/harness/index.test.ts` + the **entire existing suite** as the regression gate.

- [ ] **Step 1: Write the failing test**

```typescript
// src/harness/index.test.ts
import { describe, expect, it } from 'vitest';
import { defaultRegistry } from './index.js';

describe('defaultRegistry', () => {
  it('includes the Claude Code adapter', () => {
    expect(defaultRegistry().byId('claude-code')?.displayName).toBe('Claude Code');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/harness/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/harness/index.ts`**

```typescript
// src/harness/index.ts
import { claudeCodeAdapter } from './adapters/claude-code.js';
import { createRegistry, type HarnessRegistry } from './registry.js';

let cached: HarnessRegistry | null = null;

/** The process-wide registry of known harness adapters. */
export function defaultRegistry(): HarnessRegistry {
  if (!cached) cached = createRegistry([claudeCodeAdapter()]);
  return cached;
}

export * from './types.js';
```

- [ ] **Step 4: Rewire the callers (behavior-preserving)**

In `src/cli/cli.ts`:
- `cmdInstallHooks` (`:376`): replace `installHooks()` with `await defaultRegistry().byId('claude-code')!.install()` (or, with `--harness <id>`, resolve `byId(id)` and **refuse** with a non-zero exit + clear message when `qualifies().ok === false`; with no flag, `await defaultRegistry().detectInstalled()` and `install()` each). Map the returned `wired` moments to the existing user-facing output.
- `cmdSetup` (`:422`): keep `installHooks()`/adapter `install()` for hooks, then replace `registerMcpServer(cliPath, spawnCapture)` (`:428`) with `await adapter.registerMcp(cliPath, spawnCapture)`. The `McpRegisterStatus` union now uses `unavailable` instead of `no-claude` — update the `switch` arms accordingly (rename the `no-claude` case to `unavailable`).
- `cmdUninstall` (`:497`): replace `uninstallHooks()` with `await adapter.uninstall()`; keep `unregisterMcpServer(spawnCapture)` (MCP unregister stays direct in Phase 0 — generalizing it is Phase 1).
- `resolveSessionId` (`:808`): replace the direct `process.env.CLAUDE_CODE_SESSION_ID` read (`:816`) with `defaultRegistry().byId('claude-code')!.resolveSession({ env: process.env })`, preserving the `--session` flag branch and the `source: 'env'` semantics (a resolved id from env keeps `source: 'env'`).

In `src/mcp/server.ts`:
- `:93` and `:446`: replace `process.env.CLAUDE_CODE_SESSION_ID` with `defaultRegistry().byId('claude-code')!.resolveSession({ env: process.env })?.sessionId`, keeping the explicit-`session`-param-wins precedence (the param is still preferred; the adapter only supplies the fallback).

Do **not** change any hook handler body (`session-start.ts`, `session-end.ts`, etc.) — they already read the id from the payload and are out of scope.

- [ ] **Step 5: Run the FULL suite (the regression gate)**

Run: `npm run check`
Expected: PASS — lint + typecheck + **all existing tests green**. The `no-claude`→`unavailable` rename and the env-read centralization are the only behavior-visible changes; any pre-existing test asserting the old `no-claude` status string must be updated to `unavailable` (search: `git grep -n "no-claude" src`). If a hook/ingest/recall test fails, the wrap leaked — fix the wrap, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/harness/index.ts src/harness/index.test.ts src/cli/cli.ts src/mcp/server.ts
git commit -m "refactor(harness): route CLI install/setup/uninstall + session-id env reads through the adapter"
```

---

## Task 10: Concurrent-store hardening (busy_timeout)

**Files:**
- Modify: `src/store/memory-store.ts` (`open()`, next to the WAL pragma at `:149`).
- Test: `src/store/concurrency.test.ts`

The user runs Codex + OpenCode + Claude Code at once → concurrent **cross-process** writers to one `memory.db`. WAL is already enabled (`:149`); the genuinely new pragma is `busy_timeout`, which makes a writer wait (instead of erroring `SQLITE_BUSY`) when another connection holds the write lock.

> Honesty note: `busy_timeout` is **per-connection** and `better-sqlite3` is **synchronous**, so a single-process, same-thread test cannot reproduce real contention or observe another connection's timeout. This task therefore (a) sets the pragma and (b) verifies the **persisted, observable** property — WAL mode — via a second connection, and documents that true cross-process contention safety is validated by a manual/integration check, not faked here. Do NOT write a `Promise.all([syncCall, syncCall])` test; it proves nothing (the calls run sequentially).

- [ ] **Step 1: Confirm current pragmas**

Run: `grep -n "journal_mode\|busy_timeout\|foreign_keys" src/store/memory-store.ts`
Expected: WAL + foreign_keys present (`:149-150`); no `busy_timeout`.

- [ ] **Step 2: Write the failing test** — after `open()`, the db file is in WAL mode (persisted; readable from an independent connection).

```typescript
// src/store/concurrency.test.ts
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store.js';

const DIM = 8;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-concurrency-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('store durability pragmas', () => {
  it('opens the db in WAL mode (persisted, observable from a second connection)', () => {
    const dbPath = join(dir, 'memory.db');
    const store = new MemoryStore({ dbPath, dimensions: DIM });
    store.open();
    store.setMeta('k:a', '1');
    expect(store.getMeta('k:a')).toBe('1');
    store.close();

    const probe = new Database(dbPath);
    const mode = (probe.pragma('journal_mode', { simple: true }) as string).toLowerCase();
    probe.close();
    expect(mode).toBe('wal');
  });
});
```

- [ ] **Step 3: Add the `busy_timeout` pragma**

In `src/store/memory-store.ts`, inside `open()`, immediately after `db.pragma('journal_mode = WAL');` (`:149`):

```typescript
db.pragma('busy_timeout = 5000'); // wait up to 5s for a concurrent writer before SQLITE_BUSY
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/store/concurrency.test.ts`
Expected: PASS (WAL confirmed; the pragma line is covered by code review per the honesty note).

- [ ] **Step 5: Commit**

```bash
git add src/store/concurrency.test.ts src/store/memory-store.ts
git commit -m "feat(store): busy_timeout pragma for concurrent multi-harness writers"
```

---

## Phase 0 self-review checklist (run before declaring Phase 0 done)

- [ ] `npm run check` is fully green (lint + typecheck + all tests).
- [ ] `abs install-hooks` and `abs setup` (no `--harness` flag) wire Claude Code exactly as before; settings.json diff is byte-identical to the pre-refactor output for a fresh install.
- [ ] No file under `src/store`, `src/recall`, `src/embedding`, `src/optimize` imports anything from `src/harness` (`git grep -n "from '.*harness" src/store src/recall src/embedding src/optimize` returns nothing).
- [ ] The env var is **read** in exactly one runtime place — the Claude adapter — after Task 9 centralizes `cli.ts` and `mcp/server.ts`. Verify with the read-only pattern (which excludes tests, help text, and doc-strings that merely *name* the var): `git grep -n "process.env.CLAUDE_CODE_SESSION_ID" -- 'src/**/*.ts' ':!*.test.ts'` returns only `src/harness/adapters/claude-code.ts`. (Existing env-fallback tests like `cli.test.ts` "falls back to CLAUDE_CODE_SESSION_ID" and `set-session-project.test.ts` keep passing — they reference the var by name, not via a now-removed read.)
- [ ] The MCP **registration** status `no-claude` is gone from the harness boundary: `git grep -n "no-claude" -- 'src/harness/**'` returns nothing, and `cmdSetup`'s switch uses `unavailable`. NOTE: `UnregisterResult.no-claude` in `src/cli/setup.ts` (consumed by `cmdUninstall`, `cli.ts:514`) is **intentionally retained** in Phase 0 — `unregisterMcpServer` is generalized in Phase 1, so a repo-wide `git grep no-claude` will still match `setup.ts`/`cmdUninstall`/`setup.test.ts`, and that is expected.

---

# Follow-on work items (Phases 1–3) — for issue creation, planned in detail later

Each item is a self-contained work unit with an acceptance bar and dependency. They are **not** broken into bite-sized steps here; each gets its own `writing-plans` pass when scheduled.

### Phase 1 — Codex CLI adapter
- **Depends on:** Phase 0.
- **Scope:** `src/harness/adapters/codex.ts`; **generalize `registerMcpServer`** to accept a CLI binary + `mcp add` argv (Codex uses `codex mcp add` / `[mcp_servers]` in `~/.codex/config.toml`); **generalize the lifecycle installer** to drive per-event CLI args (Codex writes `~/.codex/hooks.json` / `[hooks]`); reuse `jsonlTranscriptSource` for `~/.codex/sessions/**/rollout-*.jsonl` (add a Codex `parseLine` variant if the RolloutLine schema differs from Claude's); `resolveSession` reads `session_id`+`transcript_path` from the hook payload (no env var). Per-harness session-row namespacing (W1) lands here.
- **Acceptance:** `abs install-hooks --harness codex` + `abs setup --harness codex` wire hooks + MCP; a real Codex session is captured and recalled; `qualifies()` returns ok.

### Phase 2a — Gemini CLI adapter
- **Depends on:** Phase 1.
- **Scope:** event map `SessionStart`/`BeforeAgent`→recall, `SessionEnd`→capture, `BeforeTool`→guard; hooks + `mcpServers` in `~/.gemini/settings.json`; JSONL transcript in `~/.gemini/tmp/<hash>/chats/` (pin to the installed version's JSON-vs-JSONL format); `GEMINI.md`/`AGENTS.md` injector.
- **Acceptance:** parity on a Gemini CLI install; version-pinned transcript parser documented.

### Phase 2a — Copilot CLI adapter
- **Depends on:** Phase 1.
- **Scope:** event map `sessionEnd`→capture, `sessionStart`/`userPromptSubmitted`→recall, `preToolUse`→guard; hooks in `~/.copilot/hooks/*.json`; MCP in `~/.copilot/mcp-config.json`; transcript files + `events.jsonl` in `~/.copilot/session-state/`.
- **Acceptance:** parity on a Copilot CLI install.

### Phase 2b — OpenCode validation spike
- **Depends on:** Phase 0. **Blocks:** OpenCode adapter.
- **Scope:** on the user's machine, confirm the plugin-event surface maps to capture/recall, the transcript format/path on the installed version (JSON vs SQLite migration), and the session-id source. Output: an ADR with a qualify/no-qualify verdict.

### Phase 2b — Antigravity CLI validation spike
- **Depends on:** Phase 0. **Blocks:** Antigravity adapter.
- **Scope:** install `agy`; (1) open a real `<ws>/.gemini/jetski/transcript.jsonl` and extract the per-message schema; (2) confirm the `conversationId` + `transcriptPath` hook payload; (3) test a minimal `Stop` hook (capture) and an idempotent `PreInvocation` hook (recall on first invocation per `conversationId`). Output: an ADR with the event-map and verdict.

### Phase 2b — OpenCode adapter (gated on spike = qualifies)
- **Scope:** a `PluginEventInstaller` capability (first non-settings-file installer) and possibly a `SqliteTranscriptSource`.
- **Acceptance:** parity on the user's OpenCode install.

### Phase 2b — Antigravity CLI adapter (gated on spike = qualifies)
- **Scope:** event map `Stop`→capture, `PreInvocation`(idempotent)→recall, `PreToolUse`→guard; MCP in `~/.gemini/antigravity-cli/mcp_config.json`; JSONL transcript at the spiked path; store-tracked per-`conversationId` injection state for idempotent recall.
- **Acceptance:** parity on an `agy` install; recall fires exactly once per conversation.

### Phase 3 — Grok Build adapter (design-ready, access-gated)
- **Depends on:** access to a SuperGrok Heavy install (the user does not have it).
- **Scope:** draft from docs (likely Codex-shaped: `~/.grok/config.toml`, hooks, `AGENTS.md`); keep `qualifies()` returning not-ok until transcript + session id are confirmed empirically.
- **Acceptance:** adapter merged but disabled by the gate; flips to enabled when a validation spike confirms parity.

### Cross-cutting — install UX + docs
- **Scope:** `abs status` shows wired harnesses + tier; auto-detect across adapters; README + `docs/agent-handbook.md` + `AGENTS.md`/`CLAUDE.md` note that memory now spans harnesses; per-harness ADRs.

---

## Deferred-by-design (called out so they are conscious, not accidental)

- **W1 — per-harness session-row namespacing:** the design doc calls for namespacing the session `external_id` by harness to avoid cross-harness id collision. Phase 0 ships only the **cursor** isolation (already path-keyed). Since Phase 0 has no non-Claude adapter, no collision is possible yet. The `external_id` / `session-project:<externalId>` namespacing lands in **Phase 1 (Codex)**, the first time two harnesses coexist. Tracked as a Phase 1 scope item above.

## Excluded (documented non-goals)
Cursor, Cline/Roo, Windsurf, Zed, Continue (no lifecycle hooks), Aider (no MCP/hooks), Amp (cloud-first, no local transcript) — excluded under the parity-only policy until they ship a qualifying lifecycle mechanism.
