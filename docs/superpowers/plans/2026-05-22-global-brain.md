# Global Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a curated, user-initiated cross-project "global brain" that is recalled on every prompt alongside the current project's memory.

**Architecture:** A single reserved session (`external_id = project = "__global__"`) holds global observations in the same store (no schema migration). Recall widens its project filter to `project OR __global__`; global hits are tagged distinctly. Writers (`abs remember --global`, MCP `remember scope:"global"`, `abs promote <id>`) are user-initiated only.

**Tech Stack:** TypeScript (ESM), better-sqlite3, sqlite-vec, FTS5, Vitest, Biome. Validate with `npm run check`. Rebuild before any live CLI test: `npm run build` (gotcha: `check` does NOT rebuild `dist/`).

---

## File structure

| File | Responsibility | Action |
| --- | --- | --- |
| `src/global.ts` | `GLOBAL_PROJECT` sentinel + `getOrCreateGlobalSession(store)` | Create |
| `src/global.test.ts` | Tests for the sentinel + reserved session | Create |
| `src/store/memory-store.ts` | `searchFts`/`knn` gain `includeGlobal` + return `project`; `listProjects` excludes sentinel; new `moveObservationToSession` | Modify |
| `src/store/store.test.ts` | Store-level tests for the above | Modify |
| `src/recall/recall.ts` | `RecallFtsOptions.includeGlobal`; `RecallHit.global`; pass through | Modify |
| `src/recall/recall.test.ts` | recallFts includeGlobal + global flag | Modify |
| `src/recall/index.ts` | Re-export `RecallHit` already; ensure `global` surfaces | Verify |
| `src/hooks/user-prompt-submit.ts` | Pass `includeGlobal: true`; tag global hits in the block | Modify |
| `src/hooks/user-prompt-submit.test.ts` | Block tags global hits | Modify |
| `src/mcp/server.ts` | `remember` gains `scope`; new `promote` tool | Modify |
| `src/mcp/server.test.ts` / `set-session-project.test.ts` | scope + promote round-trip | Modify |
| `src/cli/cli.ts` | New `remember` (`--global`) and `promote` commands; `forget --global`; `status` global count | Modify |
| `src/cli/cli.test.ts` | CLI command tests | Modify |
| `docs/agent-handbook.md` | Document the global brain + the user-initiated guardrail | Modify |

---

## Task 1: Global sentinel + reserved session

**Files:**
- Create: `src/global.ts`
- Test: `src/global.test.ts`
- Modify: `src/store/memory-store.ts:273` (`listProjects` excludes sentinel)

- [ ] **Step 1: Write the failing test**

```ts
// src/global.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './store/index.js';
import { GLOBAL_PROJECT, getOrCreateGlobalSession } from './global.js';

describe('global brain sentinel', () => {
  let dir: string;
  let store: MemoryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-global-'));
    store = new MemoryStore({ dbPath: join(dir, 'm.db'), dimensions: 8 }).open();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates one reserved session keyed by the sentinel and reuses it', () => {
    const a = getOrCreateGlobalSession(store);
    const b = getOrCreateGlobalSession(store);
    expect(a).toBe(b);
    const s = store.getSessionByExternalId(GLOBAL_PROJECT);
    expect(s?.project).toBe(GLOBAL_PROJECT);
  });

  it('hides the sentinel from listProjects (not a selectable project)', () => {
    getOrCreateGlobalSession(store);
    store.createSession({ externalId: 'real', project: '-Users-me-Devs-foo' });
    expect(store.listProjects()).toEqual(['-Users-me-Devs-foo']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/global.test.ts`
Expected: FAIL — `Cannot find module './global.js'`.

- [ ] **Step 3: Create `src/global.ts`**

```ts
/**
 * Global brain (#) — a curated, cross-project memory layer recalled on every
 * prompt alongside the project brain. It lives in the normal store as a single
 * RESERVED session whose external_id and project are both the sentinel below.
 *
 * Collision-free by construction: ingest only ever creates sessions with
 * external_id = a Claude Code session UUID and project = projectSlug(cwd) (always
 * begins with the path separator, `-…`). The literal `__global__` cannot be
 * produced by either path, so the reserved row never clashes with a real project.
 */
import type { MemoryStore } from './store/index.js';

/** Reserved external_id AND project label for the global brain. Never a real cwd slug. */
export const GLOBAL_PROJECT = '__global__';

/** Lazily get-or-create the reserved global session; returns its store id. */
export function getOrCreateGlobalSession(store: MemoryStore): number {
  const existing = store.getSessionByExternalId(GLOBAL_PROJECT);
  if (existing) return existing.id;
  return store.createSession({ externalId: GLOBAL_PROJECT, project: GLOBAL_PROJECT });
}
```

- [ ] **Step 4: Exclude the sentinel from `listProjects`**

Modify `src/store/memory-store.ts` (the `listProjects` query, ~line 273-276):

```ts
  listProjects(): string[] {
    const rows = this.conn()
      .prepare(
        "SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL AND project != '__global__' ORDER BY project",
      )
      .all() as Array<{ project: string }>;
    return rows.map((r) => r.project);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/global.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/global.ts src/global.test.ts src/store/memory-store.ts
git commit -m "feat(global): reserved global-brain session sentinel + listProjects exclusion"
```

---

## Task 2: Store recall legs — `includeGlobal` + return the hit's project

**Files:**
- Modify: `src/store/memory-store.ts:584` (`searchFts`), `:491` (`knn`)
- Test: `src/store/store.test.ts`

`searchFts`/`knn` currently return `{ id, distance }`. Extend them to (a) accept an
`includeGlobal` flag that ORs the sentinel into the project filter, and (b) return
the matched row's `project` so callers can tag global hits.

- [ ] **Step 1: Write the failing test**

```ts
// src/store/store.test.ts — add inside the existing describe (uses the test's `store`)
it('searchFts with includeGlobal returns project hits AND global hits, tagged by project', () => {
  const proj = store.createSession({ externalId: 'p1', project: '-Users-me-Devs-foo' });
  const glob = store.createSession({ externalId: '__global__', project: '__global__' });
  const o1 = store.createObservation({ sessionId: proj, kind: 'note', content: 'kangaroo project fact' });
  const o2 = store.createObservation({ sessionId: glob, kind: 'decision', content: 'kangaroo global rule' });
  store.indexFts(o1, 'kangaroo project fact');
  store.indexFts(o2, 'kangaroo global rule');

  const scoped = store.searchFts('kangaroo', 10, '-Users-me-Devs-foo'); // no global
  expect(scoped.map((h) => h.id).sort()).toEqual([o1].sort());

  const withGlobal = store.searchFts('kangaroo', 10, '-Users-me-Devs-foo', true);
  expect(withGlobal.map((h) => h.id).sort((a, b) => a - b)).toEqual([o1, o2].sort((a, b) => a - b));
  const globalHit = withGlobal.find((h) => h.id === o2);
  expect(globalHit?.project).toBe('__global__');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/store.test.ts -t includeGlobal`
Expected: FAIL — `searchFts` takes 3 args / no `project` on the hit.

- [ ] **Step 3: Implement — extend `searchFts`**

Replace `searchFts` (`src/store/memory-store.ts:584-610`) with a version that always
JOINs `sessions` (to return `project`) and applies the right filter:

```ts
  searchFts(queryText: string, k: number, project?: string, includeGlobal = false): KnnHit[] {
    const conn = this.conn();
    const base =
      `SELECT f.rowid AS id, f.rank AS distance, s.project AS project
       FROM fts_observations f
       JOIN observations o ON o.id = f.rowid
       JOIN sessions s ON s.id = o.session_id
       WHERE fts_observations MATCH ?`;
    let rows: Array<{ id: number | bigint; distance: number; project: string | null }>;
    if (project === undefined) {
      rows = conn.prepare(`${base} ORDER BY f.rank LIMIT ?`).all(queryText, k) as never;
    } else if (includeGlobal) {
      rows = conn
        .prepare(`${base} AND (s.project = ? OR s.project = '__global__') ORDER BY f.rank LIMIT ?`)
        .all(queryText, project, k) as never;
    } else {
      rows = conn
        .prepare(`${base} AND s.project = ? ORDER BY f.rank LIMIT ?`)
        .all(queryText, project, k) as never;
    }
    return rows.map((r) => ({ id: Number(r.id), distance: r.distance, project: r.project }));
  }
```

Update the `KnnHit` type (find its definition near the top of `memory-store.ts` or
`src/store/types.ts`) to add `project?: string | null`:

```ts
export interface KnnHit {
  id: number;
  distance: number;
  project?: string | null;
}
```

- [ ] **Step 4: Mirror the change in `knn`**

In `knn` (`src/store/memory-store.ts:491`), apply the same pattern: add a 4th param
`includeGlobal = false`; when `project !== undefined && includeGlobal`, change the
rowid subquery's `WHERE s.project = ?` to `WHERE s.project = ? OR s.project = '__global__'`;
and `SELECT` the project for the returned hits (JOIN as needed) so `knn` also returns
`project`. Keep the `project === undefined` (store-wide) branch returning `project: null`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/store/store.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/store/memory-store.ts src/store/types.ts src/store/store.test.ts
git commit -m "feat(global): searchFts/knn includeGlobal flag + return hit project"
```

---

## Task 3: Recall layer — thread `includeGlobal`, flag global hits

**Files:**
- Modify: `src/recall/recall.ts:129` (`recallFts`), `RecallFtsOptions`, `RecallHit`
- Test: `src/recall/recall.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/recall/recall.test.ts — new test in the recallFts describe
it('marks global-session hits with global=true when includeGlobal is set', () => {
  const proj = store.createSession({ externalId: 'p', project: '-Users-me-Devs-foo' });
  const glob = store.createSession({ externalId: '__global__', project: '__global__' });
  const op = store.createObservation({ sessionId: proj, kind: 'note', content: 'zebra project note' });
  const og = store.createObservation({ sessionId: glob, kind: 'decision', content: 'zebra global decision' });
  store.indexFts(op, 'zebra project note');
  store.indexFts(og, 'zebra global decision');

  const hits = recall.recallFts('zebra', { limit: 10, project: '-Users-me-Devs-foo', includeGlobal: true });
  const byId = new Map(hits.map((h) => [h.observation.id, h]));
  expect(byId.get(op)?.global).toBeFalsy();
  expect(byId.get(og)?.global).toBe(true);
});
```

(Use the existing `recall`/`store` setup in `recall.test.ts`; mirror its `beforeEach`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/recall/recall.test.ts -t "global=true"`
Expected: FAIL — `includeGlobal` not accepted / `global` undefined.

- [ ] **Step 3: Implement**

In `src/recall/recall.ts`: add `includeGlobal?: boolean` to `RecallFtsOptions`; add
`global?: boolean` to `RecallHit` (its interface, likely in this file or `index.ts`).
Update `recallFts` (line 129-142):

```ts
  recallFts(query: string, options: RecallFtsOptions = {}): RecallHit[] {
    const limit = options.limit ?? 8;
    const ftsExpr = toFtsQuery(query);
    if (ftsExpr === null) return [];

    const matches = this.store.searchFts(ftsExpr, limit, options.project, options.includeGlobal);
    const hits: RecallHit[] = [];
    for (const m of matches) {
      const observation = this.store.getObservation(m.id);
      if (!observation) continue;
      hits.push({
        observation,
        score: -m.distance,
        ftsRank: m.distance,
        global: m.project === '__global__',
      });
    }
    return hits;
  }
```

Import `GLOBAL_PROJECT` from `../global.js` and use it instead of the literal if you
prefer (avoids a magic string). Confirm `RecallHit` is re-exported from
`src/recall/index.ts` (it already is — just ensure `global` is on the type).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/recall/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recall/recall.ts src/recall/index.ts src/recall/recall.test.ts
git commit -m "feat(global): recallFts threads includeGlobal and flags global hits"
```

---

## Task 4: Inject the global brain on every prompt + tag it

**Files:**
- Modify: `src/hooks/user-prompt-submit.ts` (recall call + `renderRecallBlock`)
- Test: `src/hooks/user-prompt-submit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/hooks/user-prompt-submit.test.ts — add to the renderRecallBlock describe
it('tags global hits distinctly so the agent reads them as cross-project', () => {
  const projectHit = hit(1, 'note', 'Local detail about the foo service.');
  const globalHit = { ...hit(2, 'decision', 'Always use dependency injection.'), global: true };
  const block = renderRecallBlock([projectHit, globalHit]);
  expect(block).toContain('🌐global');
  expect(block).toContain('Always use dependency injection');
  // the project hit is NOT tagged global
  expect(block).toMatch(/\[note\] Local detail/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/user-prompt-submit.test.ts -t "tags global hits"`
Expected: FAIL — no `🌐global` marker.

- [ ] **Step 3: Implement the tag**

In `renderRecallBlock` (`src/hooks/user-prompt-submit.ts`), where the bullet line is
built (the `const line = ...` with `freshnessTag`/`branchTag`), add a global tag:

```ts
    const kind = hit.observation.kind;
    const globalTag = hit.global ? ' 🌐global' : '';
    const branchTag = hit.crossBranch ? ' ⎇other-branch' : '';
    const line = `- [${kind}${freshnessTag(hit.anchorState)}${globalTag}${branchTag}] ${content.replace(/\s+/g, ' ')}`;
```

- [ ] **Step 4: Pass `includeGlobal: true` from the real recall path**

In `recallFromStore` (`src/hooks/user-prompt-submit.ts`), update the `recallFts` call:

```ts
    const hits = memory.recall.recallFts(prompt, { limit: TOP_K, project, includeGlobal: true });
```

Do the same in `src/hooks/pre-tool-use.ts` `surfaceDecisions` (its `recallFts` call) so
the duplication/decision lens also sees global decisions:

```ts
  const hits = memory.recall.recallFts(query, { limit: RECALL_POOL, project, includeGlobal: true });
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/hooks/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/user-prompt-submit.ts src/hooks/user-prompt-submit.test.ts src/hooks/pre-tool-use.ts
git commit -m "feat(global): recall the global brain on every prompt, tagged 🌐global"
```

---

## Task 5: MCP `remember` gains `scope: "global"`

**Files:**
- Modify: `src/mcp/server.ts` (the `remember` registerTool closure, ~line 108-124)
- Test: `src/mcp/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/mcp/server.test.ts — exercise the remember tool via the registered handler
// (follow the file's existing pattern for invoking a tool; assert the row lands
// under the global session)
it('remember scope=global stores under the reserved global session', async () => {
  // ...set up memory like the other server tests...
  await callRememberTool(memory, { content: 'Prefer pnpm in all repos.', scope: 'global' });
  const g = memory.store.getSessionByExternalId('__global__');
  const obs = memory.store.listObservations({ sessionId: g?.id });
  expect(obs.some((o) => o.content === 'Prefer pnpm in all repos.')).toBe(true);
});
```

(If the test file has no direct tool-invocation helper, test the extracted core: do
Step 3's refactor first, then assert on `rememberAction`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/server.test.ts -t "scope=global"`
Expected: FAIL — `scope` ignored; row not under `__global__`.

- [ ] **Step 3: Implement**

In `src/mcp/server.ts`, import `getOrCreateGlobalSession` and `GLOBAL_PROJECT` from
`../global.js`. Update the `remember` tool:

```ts
      inputSchema: {
        content: z.string().min(1).describe('The text to remember.'),
        kind: z.string().optional().describe('Category, e.g. decision/lesson/note (default note).'),
        session: z.string().optional().describe('External session id to group the memory under.'),
        scope: z
          .enum(['project', 'global'])
          .optional()
          .describe(
            "Where to file it. 'global' (cross-project brain) ONLY when the user explicitly asks to save globally — never on your own initiative. Default 'project'.",
          ),
      },
    },
    async ({ content, kind, session, scope }) => {
      const sessionId =
        scope === 'global'
          ? getOrCreateGlobalSession(memory.store)
          : resolveSession(memory, session ?? DEFAULT_SESSION);
      const id = await memory.indexer.write({ sessionId, kind: kind ?? 'note', content });
      return jsonContent({ id, sessionId, scope: scope ?? 'project' });
    },
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/mcp/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/mcp/server.test.ts
git commit -m "feat(global): MCP remember scope=global (user-initiated only)"
```

---

## Task 6: `moveObservationToSession` + `abs promote` + MCP `promote`

**Files:**
- Modify: `src/store/memory-store.ts` (new `moveObservationToSession`)
- Modify: `src/mcp/server.ts` (new `promote` tool)
- Modify: `src/cli/cli.ts` (new `promote` command + dispatch)
- Test: `src/store/store.test.ts`, `src/cli/cli.test.ts`

- [ ] **Step 1: Write the failing store test**

```ts
// src/store/store.test.ts
it('moveObservationToSession re-links an observation to another session', () => {
  const a = store.createSession({ externalId: 'a', project: '-Users-me-Devs-foo' });
  const b = store.createSession({ externalId: '__global__', project: '__global__' });
  const id = store.createObservation({ sessionId: a, kind: 'decision', content: 'use RAP for S/4' });
  store.indexFts(id, 'use RAP for S/4');

  store.moveObservationToSession(id, b);

  expect(store.getObservation(id)?.sessionId).toBe(b);
  // still recallable, now under the global project
  const hits = store.searchFts('RAP', 10, '-Users-me-Devs-foo', true);
  expect(hits.find((h) => h.id === id)?.project).toBe('__global__');
  // gone from the bare project scope
  const scoped = store.searchFts('RAP', 10, '-Users-me-Devs-foo');
  expect(scoped.find((h) => h.id === id)).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/store.test.ts -t moveObservationToSession`
Expected: FAIL — method does not exist.

- [ ] **Step 3: Implement `moveObservationToSession`**

In `src/store/memory-store.ts`, add. FTS/vec rows are keyed by the observation's
`rowid` (= `observations.id`), which does NOT change, so only the FK is updated — the
index stays valid:

```ts
  /**
   * Re-link an observation to a different session (used by `promote` to lift a
   * project memory into the global brain). The observation id (= fts/vec rowid)
   * is unchanged, so the FTS and vector indexes stay valid; only the FK moves.
   */
  moveObservationToSession(observationId: number, sessionId: number): void {
    this.conn()
      .prepare('UPDATE observations SET session_id = ? WHERE id = ?')
      .run(sessionId, observationId);
  }
```

- [ ] **Step 4: Run the store test**

Run: `npx vitest run src/store/store.test.ts -t moveObservationToSession`
Expected: PASS.

- [ ] **Step 5: Write the CLI `promote` test**

```ts
// src/cli/cli.test.ts — in the hermetic ABS_HOME describe
it('promote moves an observation into the global brain', async () => {
  const mem = await openMemory(loadConfig(), { ensure: false });
  const sid = mem.store.createSession({ externalId: 's', project: '-Users-me-Devs-foo' });
  const id = mem.store.createObservation({ sessionId: sid, kind: 'decision', content: 'monorepo via turborepo' });
  mem.store.indexFts(id, 'monorepo via turborepo');
  mem.close();

  await cmdPromote([String(id), '--json']);
  const o = JSON.parse(outLines.join(''));
  expect(o).toMatchObject({ id, scope: 'global', applied: true });

  const mem2 = await openMemory(loadConfig(), { ensure: false });
  const g = mem2.store.getSessionByExternalId('__global__');
  expect(mem2.store.getObservation(id)?.sessionId).toBe(g?.id);
  mem2.close();
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/cli/cli.test.ts -t "promote moves"`
Expected: FAIL — `cmdPromote` undefined.

- [ ] **Step 7: Implement `cmdPromote` + dispatch + MCP `promote`**

In `src/cli/cli.ts` add (and export) `cmdPromote`, plus a `case 'promote':` in `main`
and a help line:

```ts
/** `abs promote <observationId>` — move a project memory into the global brain. */
export async function cmdPromote(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const idArg = positional(args);
  const id = idArg ? Number.parseInt(idArg, 10) : Number.NaN;
  if (!Number.isInteger(id)) {
    err('error: promote requires an observation id, e.g. `abs promote 42`');
    process.exitCode = 1;
    return;
  }
  const memory = await openMemory(loadConfig(), { ensure: false });
  try {
    if (!memory.store.getObservation(id)) {
      err(`error: no observation with id ${id}`);
      process.exitCode = 1;
      return;
    }
    const globalSession = getOrCreateGlobalSession(memory.store);
    memory.store.moveObservationToSession(id, globalSession);
    if (json) out(JSON.stringify({ id, scope: 'global', applied: true }));
    else out(`promoted observation ${id} to the global brain.`);
  } finally {
    memory.close();
  }
}
```

Add the dispatch in `main` (near the other `case` lines ~828-853):

```ts
    case 'promote':
      await cmdPromote(rest);
      break;
```

Import `getOrCreateGlobalSession` from `../global.js` at the top of `cli.ts`.

In `src/mcp/server.ts` register a `promote` tool mirroring it:

```ts
  server.registerTool(
    'promote',
    {
      title: 'Promote a memory to the global brain',
      description:
        'Move an existing observation into the cross-project global brain. Use ONLY when the user explicitly asks to promote/save something globally — never on your own initiative.',
      inputSchema: { id: z.number().int().describe('Observation id to promote.') },
    },
    async ({ id }) => {
      if (!memory.store.getObservation(id)) return jsonContent({ error: `no observation ${id}` });
      const g = getOrCreateGlobalSession(memory.store);
      memory.store.moveObservationToSession(id, g);
      return jsonContent({ id, scope: 'global', applied: true });
    },
  );
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run src/cli/cli.test.ts src/mcp/ src/store/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/store/memory-store.ts src/store/store.test.ts src/mcp/server.ts src/cli/cli.ts src/cli/cli.test.ts
git commit -m "feat(global): promote (move) a memory into the global brain — CLI + MCP"
```

---

## Task 7: `abs remember --global` (CLI authoring)

**Files:**
- Modify: `src/cli/cli.ts` (new `remember` command + dispatch + help)
- Test: `src/cli/cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/cli/cli.test.ts — hermetic ABS_HOME describe
it('remember --global writes under the reserved global session', async () => {
  await cmdRemember(['Always pin Node with .nvmrc.', '--global', '--kind', 'lesson', '--json']);
  const o = JSON.parse(outLines.join(''));
  expect(o).toMatchObject({ scope: 'global', applied: true });

  const mem = await openMemory(loadConfig(), { ensure: false });
  const g = mem.store.getSessionByExternalId('__global__');
  const obs = mem.store.listObservations({ sessionId: g?.id });
  expect(obs.some((x) => x.content === 'Always pin Node with .nvmrc.')).toBe(true);
  mem.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/cli/cli.test.ts -t "remember --global"`
Expected: FAIL — `cmdRemember` undefined.

- [ ] **Step 3: Implement `cmdRemember` + dispatch + help**

In `src/cli/cli.ts` add (and export) `cmdRemember`. v1 requires `--global` (project-
scoped authoring stays in the MCP `remember`/ingest paths):

```ts
/** `abs remember "<text>" --global [--kind K]` — author a global-brain memory. */
export async function cmdRemember(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const text = positional(args);
  if (!text) {
    err('error: remember requires text, e.g. `abs remember "..." --global`');
    process.exitCode = 1;
    return;
  }
  if (!args.includes('--global')) {
    err('error: `abs remember` currently writes only to the global brain — pass --global');
    process.exitCode = 1;
    return;
  }
  const kind = optionValue(args, '--kind') ?? 'note';
  const memory = await openMemory(loadConfig(), { ensure: false });
  try {
    const sessionId = getOrCreateGlobalSession(memory.store);
    const id = await memory.indexer.write({ sessionId, kind, content: text });
    if (json) out(JSON.stringify({ id, scope: 'global', kind, applied: true }));
    else out(`remembered to the global brain (id ${id}, ${kind}).`);
  } finally {
    memory.close();
  }
}
```

Add `case 'remember': await cmdRemember(rest); break;` to `main`, and a help line:

```
  remember "<text>" --global [--kind K]
                        Add a memory to the cross-project global brain (recalled in
                        every project). --kind decision|lesson|note (default note).
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/cli/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/cli.ts src/cli/cli.test.ts
git commit -m "feat(global): abs remember --global authoring command"
```

---

## Task 8: `abs forget --global` + `abs status` global count

**Files:**
- Modify: `src/cli/cli.ts` (`forget` selector + `status`)
- Test: `src/cli/cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/cli/cli.test.ts
it('forget --global selects observations under the global brain', async () => {
  const mem = await openMemory(loadConfig(), { ensure: false });
  const g = getOrCreateGlobalSession(mem.store);
  const id = mem.store.createObservation({ sessionId: g, kind: 'note', content: 'global junk' });
  mem.store.indexFts(id, 'global junk');
  mem.close();

  await cmdForget(['--global', '--json']); // preview-only (no --apply)
  const o = JSON.parse(outLines.join(''));
  expect(o.matched).toBeGreaterThanOrEqual(1);
});
```

(Match the assertion to `cmdForget`'s actual preview JSON shape — inspect a nearby
existing forget test for the exact keys.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/cli/cli.test.ts -t "forget --global"`
Expected: FAIL — `--global` not a recognized selector.

- [ ] **Step 3: Implement**

In the forget selector parser (`parseSelector`/`cmdForget`, ~`src/cli/cli.ts:502-549`),
add `--global` as a selector that maps to `byProject: '__global__'` (reuse the existing
`byProject` path; do not invent a new one). Confirm it is mutually exclusive with the
other selectors (same "exactly one selector" check).

In the `status` JSON/text output (the `cmdStatus`/`status` command), add a
`globalObservations` count:

```ts
const g = memory.store.getSessionByExternalId('__global__');
const globalObservations = g ? memory.store.listObservations({ sessionId: g.id }).length : 0;
// include globalObservations in the printed/JSON status
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/cli/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/cli.ts src/cli/cli.test.ts
git commit -m "feat(global): forget --global selector + status global count"
```

---

## Task 9: Documentation + guardrail

**Files:**
- Modify: `docs/agent-handbook.md`

- [ ] **Step 1: Document the global brain + the user-initiated guardrail**

Add a bullet in the commands/behavior section of `docs/agent-handbook.md`:

```markdown
- **Global brain** (curated, cross-project memory recalled in *every* project alongside
  the project brain): a reserved session (`__global__`). Authoring is **user-initiated
  only** — write to it (MCP `remember` `scope:"global"`, `abs remember --global`) or
  promote an existing memory into it (MCP `promote`, `abs promote <id>` — moves the
  observation) ONLY when the user explicitly asks; never on your own initiative. Recall
  ORs the global session into the project filter (`recallFts({ includeGlobal: true })`)
  and tags global hits `🌐global`. `abs forget --global` prunes it; `abs status` counts
  it. It is relevance-based like the project brain (no always-inject tier).
```

- [ ] **Step 2: Full validation**

Run: `npm run check`
Expected: lint + typecheck + all tests PASS. Fix import ordering with `npm run lint:fix` if Biome flags it.

- [ ] **Step 3: Commit**

```bash
git add docs/agent-handbook.md
git commit -m "docs: document the global brain + user-initiated guardrail"
```

---

## Done-when

- `abs remember --global "X"` then, from a DIFFERENT project's session, a relevant
  prompt recalls `X` tagged `🌐global` (cross-project proof, validated live after
  `npm run build`).
- `abs promote <id>` moves a project memory into the global brain; it stops appearing
  under the project scope and starts appearing globally.
- The agent only writes/promotes globally when the user explicitly asks.
- `npm run check` green; no schema migration; `__global__` never appears as a
  selectable project.
