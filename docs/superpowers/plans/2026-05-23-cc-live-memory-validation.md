# Live Claude Code memory-loop validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the full agentbrainsystem memory loop by driving a real headless Claude Code — capture (SessionEnd) → store → recall → per-prompt injection → the model uses it — and ship a reproducible opt-in harness, a certification run, and an impactful split before/after README GIF.

**Architecture:** A thin `driver.ts` is the only unit that knows the `claude` CLI (spawns it with an isolated `ABS_HOME` + merged `--settings`, parses `--output-format stream-json --include-hook-events`). Pure `assert.ts` evaluates the parsed events (injection gate + behavioral keyword-set). `scenario.live.ts` orchestrates Session A → capture gate → Session B, opt-in via `ABS_LIVE_CC=1` and excluded from `npm run check`/CI. A shell layer (`certify-1.0.sh`) collects evidence; vhs `.tape` files + `ffmpeg` compose the README GIF. The isolation model (proven in Step-0 spike): keep the real `HOME` so auth works, isolate only the store (`ABS_HOME`) and hooks (`--settings`).

**Tech Stack:** Node ≥22 + TypeScript (ESM), Vitest, `claude` CLI 2.1.150 (`-p` stream-json), `node:child_process`, vhs 0.11, ffmpeg. The built binary `dist/cli/cli.js` is the artifact under test.

**Spike status:** Step 0 PASSED (see spec). All mechanics below are confirmed working against real `claude -p` — no fallbacks are part of this plan.

---

## Task 0: Land the root-cause repo fix (committed `node_modules` symlink)

**Files:**
- Modify: `.gitignore`
- Index: untrack `node_modules` (already `git rm --cached`'d this session)

- [ ] **Step 1: Confirm the staged untrack + real dir intact**

Run:
```bash
git status --short | grep node_modules     # expect: "D  node_modules"
git ls-files node_modules                  # expect: empty (untracked)
ls -d node_modules/zod >/dev/null && echo OK
```
Expected: `D  node_modules`, empty ls-files, `OK`.

- [ ] **Step 2: Harden `.gitignore` so a bare symlink named `node_modules` is also ignored**

In `.gitignore`, ensure both forms exist (the slash-only form misses a symlink file):
```gitignore
node_modules/
node_modules
```

- [ ] **Step 3: Commit the fix on `main`**

```bash
git add -A .gitignore node_modules
git commit -m "fix(repo): stop tracking the node_modules symlink that self-references in main

A node_modules symlink (mode 120000 → absolute repo path) was committed; in
the main worktree it points at itself, breaking all runtime (zod unresolved,
abs CLI + MCP down) on every fresh checkout. Untrack it and ignore the bare
name so worktrees no longer inherit the loop."
```
Expected: commit succeeds; `git status` no longer shows `node_modules`.

---

## Task 1: Fixture payments API + deterministic prompts

**Files:**
- Create: `e2e/live/fixture-project/order.ts`
- Create: `e2e/live/fixture-project/money.ts`
- Create: `e2e/live/fixture-project/README.md`
- Create: `e2e/live/prompts.ts`

- [ ] **Step 1: Create the fixture source files (small but authentic)**

`e2e/live/fixture-project/money.ts`:
```typescript
/** All monetary amounts in this codebase are integer cents — never floats. */
export type Cents = number;

export function formatCents(amount: Cents): string {
  if (!Number.isInteger(amount)) throw new Error('amount must be integer cents');
  return `$${(amount / 100).toFixed(2)}`;
}
```

`e2e/live/fixture-project/order.ts`:
```typescript
import type { Cents } from './money.js';

export interface Order {
  id: string;
  /** Total in integer cents. */
  totalCents: Cents;
}

export function createOrder(id: string, totalCents: Cents): Order {
  if (!Number.isInteger(totalCents)) throw new Error('totalCents must be integer cents');
  return { id, totalCents };
}
```

`e2e/live/fixture-project/README.md`:
```markdown
# checkout-api (fixture)

A tiny payments API used by the live Claude Code memory-loop validation.
Money is stored as integer cents; the session token is an httpOnly cookie.
```

- [ ] **Step 2: Define the deterministic prompts**

`e2e/live/prompts.ts`:
```typescript
/**
 * Session A drives the model to ARTICULATE AND COMMIT the decisions in its reply,
 * so the captured assistant turns carry them (recall then feels organic, not a
 * pre-stated user line). Session B is a natural follow-up whose correct answer
 * depends on Session A's decisions.
 */
export const SESSION_A_PROMPT =
  'You are working on this checkout-api. We just resolved two things — state each as a ' +
  'clear, committed decision in your reply, with the reason: (1) store all monetary ' +
  'amounts as integer cents, never floats, because a float rounding bug hit us in ' +
  'production; (2) keep the session token in an httpOnly cookie, never localStorage, to ' +
  'limit XSS exposure. Confirm both decisions in your own words.';

export const SESSION_B_PROMPT =
  "I'm adding a refund endpoint to this payments API. How should I represent the refund " +
  'amount in code, and where should the auth token live?';

/** Keyword-sets the WITH-memory answer must satisfy (tolerant of phrasing). */
export const EXPECTED_KEYWORDS = {
  money: [/cent/i, /integer/i],
  token: [/httponly/i, /cookie/i],
} as const;
```

- [ ] **Step 3: Commit**

```bash
git add e2e/live/fixture-project e2e/live/prompts.ts
git commit -m "test(live): add payments-API fixture + deterministic prompts for CC validation"
```

---

## Task 2: `driver.ts` — spawn `claude` and parse stream-json

**Files:**
- Create: `e2e/live/driver.ts`
- Create: `e2e/live/driver.test.ts`
- Create: `e2e/live/__fixtures__/session-b.stream.jsonl` (captured real stream — see Step 1)

- [ ] **Step 1: Capture a real stream-json fixture for parser tests**

Run a single real Session B (reusing the proven invocation) and save its stream to the
fixture path, so the parser is unit-tested offline without spawning `claude`:
```bash
# (one-time, manual — needs auth; ~1 haiku turn)
SPK=$(mktemp -d); mkdir -p "$SPK/abs" "$SPK/proj"
CLI="$PWD/dist/cli/cli.js"
printf '{"hooks":{"SessionEnd":[{"matcher":"","hooks":[{"type":"command","command":"node %s hook session-end","timeout":30}]}],"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":"node %s hook user-prompt-submit","timeout":10}]}]}}' "$CLI" "$CLI" > "$SPK/settings.json"
( cd "$SPK/proj" && ABS_HOME="$SPK/abs" claude -p "We store money as integer cents, never floats." --model haiku --settings "$SPK/settings.json" --mcp-config '{"mcpServers":{}}' --strict-mcp-config )
( cd "$SPK/proj" && ABS_HOME="$SPK/abs" claude -p "How do I store a refund amount?" --model haiku --settings "$SPK/settings.json" --mcp-config '{"mcpServers":{}}' --strict-mcp-config --output-format stream-json --include-hook-events --verbose ) > e2e/live/__fixtures__/session-b.stream.jsonl
rm -rf "$SPK"
```
Expected: the fixture file contains lines incl. `"subtype":"hook_response"` with
`"hook_event":"UserPromptSubmit"` and `<recalled-memory>` inside `output`.

- [ ] **Step 2: Write the failing parser test**

`e2e/live/driver.test.ts`:
```typescript
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseStream, type StreamEvents } from './driver.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '__fixtures__/session-b.stream.jsonl');

describe('parseStream', () => {
  it('extracts the UserPromptSubmit injection and the assistant answer', () => {
    const ev: StreamEvents = parseStream(readFileSync(FIXTURE, 'utf8'));
    expect(ev.promptSubmitInjection).toBeDefined();
    expect(ev.promptSubmitInjection).toContain('<recalled-memory>');
    expect(ev.assistantText.length).toBeGreaterThan(0);
  });

  it('tolerates blank/garbage lines without throwing', () => {
    const ev = parseStream('\n{not json}\n{"type":"result","subtype":"success","result":"ok"}\n');
    expect(ev.resultText).toBe('ok');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run e2e/live/driver.test.ts`
Expected: FAIL — `parseStream` not exported / module not found.

- [ ] **Step 4: Implement `driver.ts`**

`e2e/live/driver.ts`:
```typescript
/**
 * The ONLY unit that knows the `claude` CLI. Spawns a real headless session with the
 * store + hooks isolated (ABS_HOME + merged --settings; HOME left intact so auth works —
 * proven in the Step-0 spike) and parses `--output-format stream-json
 * --include-hook-events` into typed fields.
 */
import { spawn } from 'node:child_process';

export interface StreamEvents {
  /** additionalContext injected by the UserPromptSubmit hook (the recalled-memory block), if any. */
  promptSubmitInjection?: string;
  /** Concatenated assistant text turns. */
  assistantText: string;
  /** The final `result` payload text. */
  resultText: string;
  /** Every hook_event name seen (for asserting the hook fired). */
  hookEvents: string[];
}

/** Pull additionalContext out of a hook_response `output` (a JSON string). */
function extractInjection(output: unknown): string | undefined {
  if (typeof output !== 'string') return undefined;
  try {
    const o = JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: string } };
    return o.hookSpecificOutput?.additionalContext;
  } catch {
    return undefined;
  }
}

/** Parse newline-delimited stream-json. Tolerant: blank/garbage lines are skipped. */
export function parseStream(raw: string): StreamEvents {
  const ev: StreamEvents = { assistantText: '', resultText: '', hookEvents: [] };
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type === 'system' && o.subtype === 'hook_response') {
      const name = String(o.hook_event ?? '');
      if (name) ev.hookEvents.push(name);
      if (name === 'UserPromptSubmit') {
        const inj = extractInjection(o.output);
        if (inj) ev.promptSubmitInjection = inj;
      }
    } else if (o.type === 'assistant') {
      const content = (o.message as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
      for (const c of content) if (c.type === 'text' && c.text) ev.assistantText += `${c.text}\n`;
    } else if (o.type === 'result') {
      ev.resultText = String((o as { result?: unknown }).result ?? '');
    }
  }
  return ev;
}

export interface RunOptions {
  prompt: string;
  cwd: string;
  absHome: string;
  settingsPath: string;
  model?: string;
  /** Add stream-json + hook events (Session B). Session A omits it. */
  streamHooks?: boolean;
}

export interface RunResult {
  raw: string;
  code: number;
  events: StreamEvents;
}

/** Spawn one real `claude -p` session. Returns raw stdout + parsed events. */
export function runClaude(opts: RunOptions): Promise<RunResult> {
  const args = [
    '-p',
    opts.prompt,
    '--model',
    opts.model ?? 'haiku',
    '--settings',
    opts.settingsPath,
    '--mcp-config',
    '{"mcpServers":{}}',
    '--strict-mcp-config',
  ];
  if (opts.streamHooks) {
    args.push('--output-format', 'stream-json', '--include-hook-events', '--verbose');
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn('claude', args, {
      cwd: opts.cwd,
      env: { ...process.env, ABS_HOME: opts.absHome },
    });
    let raw = '';
    child.stdout.on('data', (d) => {
      raw += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ raw, code: code ?? 0, events: parseStream(raw) });
    });
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run e2e/live/driver.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add e2e/live/driver.ts e2e/live/driver.test.ts e2e/live/__fixtures__/session-b.stream.jsonl
git commit -m "test(live): claude driver + stream-json parser with offline fixture test"
```

---

## Task 3: `assert.ts` — injection gate + behavioral keyword-set

**Files:**
- Create: `e2e/live/assert.ts`
- Create: `e2e/live/assert.test.ts`

- [ ] **Step 1: Write the failing test**

`e2e/live/assert.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { assertBehavioral, assertInjection } from './assert.js';
import { EXPECTED_KEYWORDS } from './prompts.js';

describe('assertInjection', () => {
  it('passes when the recalled-memory fence carries the decision', () => {
    const inj =
      'Relevant memory recalled from project "x"...\n<recalled-memory>\n' +
      '- [assistant] store monetary amounts as integer cents, never floats\n</recalled-memory>';
    const r = assertInjection(inj, [/cent/i]);
    expect(r.ok).toBe(true);
  });
  it('fails when there is no injection at all', () => {
    expect(assertInjection(undefined, [/cent/i]).ok).toBe(false);
  });
  it('fails when the fence is missing the expected keyword', () => {
    const inj = '<recalled-memory>\n- [assistant] unrelated note\n</recalled-memory>';
    expect(assertInjection(inj, [/cent/i]).ok).toBe(false);
  });
});

describe('assertBehavioral', () => {
  it('passes when the answer satisfies every keyword-set', () => {
    const answer = 'Use integer cents, and keep the token in an httpOnly cookie.';
    const r = assertBehavioral(answer, [...EXPECTED_KEYWORDS.money, ...EXPECTED_KEYWORDS.token]);
    expect(r.ok).toBe(true);
  });
  it('reports which keyword-set was missed', () => {
    const r = assertBehavioral('Use integer cents.', [/httponly/i]);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('/httponly/i');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run e2e/live/assert.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `assert.ts`**

`e2e/live/assert.ts`:
```typescript
/** Pure assertions over parsed stream events. No spawn, no I/O. */

export interface AssertResult {
  ok: boolean;
  missing: string[];
}

const FENCE_OPEN = '<recalled-memory>';
const FENCE_CLOSE = '</recalled-memory>';

/**
 * Deterministic injection gate: the UserPromptSubmit additionalContext must exist, carry
 * the recalled-memory fence, and the fenced block must match every required pattern.
 */
export function assertInjection(
  injection: string | undefined,
  required: readonly RegExp[],
): AssertResult {
  if (!injection || !injection.includes(FENCE_OPEN)) {
    return { ok: false, missing: ['<no recalled-memory injection>'] };
  }
  const start = injection.indexOf(FENCE_OPEN) + FENCE_OPEN.length;
  const end = injection.indexOf(FENCE_CLOSE);
  const fenced = end > start ? injection.slice(start, end) : injection.slice(start);
  const missing = required.filter((re) => !re.test(fenced)).map(String);
  return { ok: missing.length === 0, missing };
}

/** Behavioral check: the model's answer must satisfy every keyword pattern. */
export function assertBehavioral(answer: string, required: readonly RegExp[]): AssertResult {
  const missing = required.filter((re) => !re.test(answer)).map(String);
  return { ok: missing.length === 0, missing };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run e2e/live/assert.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add e2e/live/assert.ts e2e/live/assert.test.ts
git commit -m "test(live): injection gate + behavioral keyword-set assertions"
```

---

## Task 4: `scenario.live.ts` — the opt-in full-loop smoke

**Files:**
- Create: `e2e/live/scenario.live.ts`
- Create: `e2e/live/setup.ts` (isolated home/settings builder — mirrors the proven spike scaffold)

- [ ] **Step 1: Implement the isolated-scaffold helper**

`e2e/live/setup.ts`:
```typescript
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../..');
export const CLI = resolve(REPO_ROOT, 'dist/cli/cli.js');
const FIXTURE_SRC = resolve(HERE, 'fixture-project');

export interface LiveScaffold {
  proj: string;
  absHome: string;
  settingsPath: string;
  /** Count observations in the isolated store (capture gate). */
  observationCount(): number;
  cleanup(): void;
}

/** Build an isolated store + project copy + settings.json pointing at the BUILT binary. */
export function makeScaffold(): LiveScaffold {
  const root = mkdtempSync(join(tmpdir(), 'abs-live-'));
  const absHome = join(root, 'abs');
  const proj = join(root, 'proj');
  mkdirSync(absHome, { recursive: true });
  cpSync(FIXTURE_SRC, proj, { recursive: true });
  const settingsPath = join(root, 'settings.json');
  const cmd = (event: string) => `node ${CLI} hook ${event}`;
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: cmd('session-end'), timeout: 30 }] }],
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: cmd('user-prompt-submit'), timeout: 10 }] },
        ],
      },
    }),
  );
  return {
    proj,
    absHome,
    settingsPath,
    observationCount(): number {
      const out = execFileSync('node', [CLI, 'status'], {
        env: { ...process.env, ABS_HOME: absHome },
        encoding: 'utf8',
      });
      const m = out.match(/"observations":\s*(\d+)/);
      return m ? Number(m[1]) : 0;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 2: Implement the opt-in scenario**

`e2e/live/scenario.live.ts`:
```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runClaude } from './driver.js';
import { assertBehavioral, assertInjection } from './assert.js';
import { EXPECTED_KEYWORDS, SESSION_A_PROMPT, SESSION_B_PROMPT } from './prompts.js';
import { type LiveScaffold, makeScaffold } from './setup.js';

const LIVE = process.env.ABS_LIVE_CC === '1';
const d = LIVE ? describe : describe.skip;

d('live Claude Code memory loop (opt-in: ABS_LIVE_CC=1)', () => {
  let s: LiveScaffold;
  beforeAll(() => {
    s = makeScaffold();
  });
  afterAll(() => s?.cleanup());

  it('captures Session A, recalls + injects into Session B, and the model uses it', async () => {
    // Session A — capture (SessionEnd ingests on clean exit).
    const a = await runClaude({
      prompt: SESSION_A_PROMPT,
      cwd: s.proj,
      absHome: s.absHome,
      settingsPath: s.settingsPath,
    });
    expect(a.code).toBe(0);

    // Capture gate — the store must now hold the decisions.
    expect(s.observationCount()).toBeGreaterThan(0);

    // Session B — recall + injection (deterministic) + use (behavioral).
    const b = await runClaude({
      prompt: SESSION_B_PROMPT,
      cwd: s.proj,
      absHome: s.absHome,
      settingsPath: s.settingsPath,
      streamHooks: true,
    });
    expect(b.code).toBe(0);

    // GATE: the recalled-memory fence carried the money decision.
    const inj = assertInjection(b.events.promptSubmitInjection, EXPECTED_KEYWORDS.money);
    expect(inj.ok, `injection missing: ${inj.missing.join(', ')}`).toBe(true);

    // Corroborating: the answer used the decision.
    const beh = assertBehavioral(b.events.assistantText, EXPECTED_KEYWORDS.money);
    expect(beh.ok, `behavioral missing: ${beh.missing.join(', ')}`).toBe(true);
  }, 180_000);
});
```

- [ ] **Step 3: Verify it is skipped by default (no auth/tokens spent in `check`)**

Run: `npx vitest run -c vitest.e2e.config.ts e2e/live/scenario.live.ts`
Expected: the describe block is **skipped** (0 tests run) because `ABS_LIVE_CC` is unset.

- [ ] **Step 4: Run it live once to confirm green**

Run: `npm run build && ABS_LIVE_CC=1 npx vitest run -c vitest.e2e.config.ts e2e/live/scenario.live.ts`
Expected: PASS (1 test). (Spends a few haiku turns; needs `claude` auth.)

- [ ] **Step 5: Ensure `vitest.e2e.config.ts` includes `e2e/live/**` and `npm run check` does NOT**

Check `vitest.e2e.config.ts` `include` covers `e2e/**/*.live.ts`; confirm the default
`vitest` config (used by `npm test`/`check`) excludes `e2e/`. Adjust globs only if needed.

Run: `npm run check` — expected: green, and it never runs `*.live.ts`.

- [ ] **Step 6: Commit**

```bash
git add e2e/live/setup.ts e2e/live/scenario.live.ts vitest.e2e.config.ts
git commit -m "test(live): opt-in full-loop CC smoke (ABS_LIVE_CC=1), skipped in check/CI"
```

---

## Task 5: `certify-1.0.sh` — certification run with evidence

**Files:**
- Create: `scripts/certify-1.0.sh`
- Create: `artifacts/.gitignore` (ignore raw evidence, keep the dir)

- [ ] **Step 1: Write the script**

`scripts/certify-1.0.sh`:
```bash
#!/usr/bin/env bash
# Certify the 1.0 memory loop against a REAL Claude Code. Opt-in; needs auth + tokens.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="artifacts/certify-1.0"; mkdir -p "$OUT"
echo "→ building"; npm run build >/dev/null
echo "→ running live full-loop smoke (haiku)"
ABS_LIVE_CC=1 npx vitest run -c vitest.e2e.config.ts e2e/live/scenario.live.ts \
  --reporter=verbose 2>&1 | tee "$OUT/run.log"
echo "PASS — evidence in $OUT/" 
```

- [ ] **Step 2: Make it executable + ignore raw evidence**

```bash
chmod +x scripts/certify-1.0.sh
printf '*\n!.gitignore\n' > artifacts/.gitignore
```

- [ ] **Step 3: Run the certification**

Run: `./scripts/certify-1.0.sh`
Expected: `PASS — evidence in artifacts/certify-1.0/`; `run.log` shows 1 passing test.

- [ ] **Step 4: Commit the script (not the raw evidence)**

```bash
git add scripts/certify-1.0.sh artifacts/.gitignore
git commit -m "chore(certify): one-command 1.0 live memory-loop certification"
```

---

## Task 6: The split before/after README GIF

**Files:**
- Create: `e2e/live/gif/with.tape`
- Create: `e2e/live/gif/without.tape`
- Create: `e2e/live/gif/run-panel.sh` (drives one panel against a pre-seeded store)
- Create: `scripts/make-readme-gif.sh` (vhs ×2 → ffmpeg hstack → `docs/assets/`)

- [ ] **Step 1: Panel runner — one visible `claude` turn over a seeded store**

`e2e/live/gif/run-panel.sh` takes a mode (`with`|`without`), an `ABS_HOME`, a project
dir, and a settings file, then runs the **same** Session-B question. `with` uses the
abs-hooks settings (memory injected); `without` uses an empty settings file (no hooks →
amnesia). It prints a short labeled header + the prompt + the answer so the terminal frame
reads cleanly. (Full script body written during implementation — it is a thin wrapper over
`claude -p ... --model "$ABS_GIF_MODEL"`, defaulting to the default model for the final
recording per the spec.)

- [ ] **Step 2: vhs tapes themed to the brand palette**

`e2e/live/gif/with.tape` (and `without.tape`, identical but mode=without):
```
Output e2e/live/gif/with.gif
Set Theme { "name": "abs", "background": "#1A1825", "foreground": "#E6E4ED", "cursor": "#8B5CF6", "selection": "#6D28D9", "black": "#0A0810", "purple": "#8B5CF6", "cyan": "#22D3EE", "green": "#5EEAD4", "white": "#E6E4ED" }
Set FontSize 18
Set Width 920
Set Height 640
Set Padding 28
Type "bash e2e/live/gif/run-panel.sh with"
Enter
Sleep 12s
```

- [ ] **Step 3: Compose the split with ffmpeg**

`scripts/make-readme-gif.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# 1) seed an isolated store (Session A) once, shared by both panels
# 2) render both panels (default model for the public asset)
ABS_GIF_MODEL="${ABS_GIF_MODEL:-sonnet}" vhs e2e/live/gif/without.tape
ABS_GIF_MODEL="${ABS_GIF_MODEL:-sonnet}" vhs e2e/live/gif/with.tape
# 3) stack side by side with labels + a violet divider
ffmpeg -y -i e2e/live/gif/without.gif -i e2e/live/gif/with.gif -filter_complex \
  "[0:v]drawtext=text='WITHOUT agentbrainsystem':fontcolor=0x9A95AD:fontsize=20:x=(w-tw)/2:y=12[l]; \
   [1:v]drawtext=text='WITH agentbrainsystem':fontcolor=0x8B5CF6:fontsize=20:x=(w-tw)/2:y=12[r]; \
   [l][r]hstack=inputs=2,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
  docs/assets/certify-loop.gif
echo "→ docs/assets/certify-loop.gif"
```

- [ ] **Step 4: Generate the GIF (final = default model)**

Run: `chmod +x e2e/live/gif/run-panel.sh scripts/make-readme-gif.sh && ABS_GIF_MODEL=sonnet ./scripts/make-readme-gif.sh`
Expected: `docs/assets/certify-loop.gif` exists; eyeball it — left shows amnesia, right
shows the `<recalled-memory>` block + the correct cents/httpOnly answer.

- [ ] **Step 5: Iterate cheaply on haiku if framing needs tuning**

Re-run with `ABS_GIF_MODEL=haiku` while adjusting tape timings/sizes; do the final pass on
the default model.

- [ ] **Step 6: Commit the GIF + tooling**

```bash
git add e2e/live/gif scripts/make-readme-gif.sh docs/assets/certify-loop.gif
git commit -m "docs(assets): split before/after memory-loop GIF + reproducible vhs/ffmpeg tooling"
```

---

## Task 7: Swap the README GIF + document the live suite

**Files:**
- Modify: `README.md` (the demo `<img>` near the top)
- Modify: `docs/testing-strategy.md` (new section)
- Modify: `docs/agent-handbook.md` (Repository Map: add `e2e/live/`)

- [ ] **Step 1: Replace the README demo image**

In `README.md`, swap the existing `docs/assets/demo.gif` `<img>` for
`docs/assets/certify-loop.gif`, updating the `alt` to describe the before/after proof
(e.g. "Same question, two sessions: without agentbrainsystem the agent has no memory of the
past decision; with it, the recalled-memory block injects the 'integer cents' decision and
the agent answers correctly"). Remove `demo.gif` only after confirming the new asset
renders.

- [ ] **Step 2: Document the live suite in `docs/testing-strategy.md`**

Add a "Live Claude Code Smoke" section: what it proves (full loop end-to-end), that it is
opt-in (`ABS_LIVE_CC=1`), excluded from `check`/CI (needs auth + tokens), how to run
(`./scripts/certify-1.0.sh`), and the isolation model (HOME intact, `ABS_HOME` + `--settings`
isolated).

- [ ] **Step 3: Add `e2e/live/` to the Repository Map**

In `docs/agent-handbook.md`, add a row for `e2e/live/` describing the real-CC harness.

- [ ] **Step 4: Final gate + commit**

Run: `npm run check`
Expected: green (live suite not executed).
```bash
git add README.md docs/testing-strategy.md docs/agent-handbook.md
git commit -m "docs: feature the before/after memory-loop GIF + document the live CC smoke"
```

---

## Self-review notes

- **Spec coverage:** isolation model (Task 4/setup.ts), Step-0 mechanics (baked in, spike
  passed), scenario A→gate→B (Task 4), deterministic+behavioral proof (Task 3/4), opt-in &
  out of CI (Task 4 step 3/5), certification run (Task 5), split before/after GIF honesty
  (Task 6), README swap (Task 7), root-cause repo fix (Task 0). All covered.
- **Type consistency:** `parseStream`/`StreamEvents`/`runClaude`/`RunOptions` (Task 2) are
  consumed unchanged in Task 4; `assertInjection`/`assertBehavioral`/`AssertResult`
  (Task 3) consumed in Task 4; `EXPECTED_KEYWORDS`/`SESSION_A_PROMPT`/`SESSION_B_PROMPT`
  (Task 1) consumed in Tasks 3/4.
- **No placeholders:** the only deferred bodies are `run-panel.sh` (Task 6 step 1) and the
  `without.tape` twin — both fully specified in prose + the sibling concrete file; written
  during implementation against the proven invocation.
