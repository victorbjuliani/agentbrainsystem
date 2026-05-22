/**
 * E2E — CLI surface against the BUILT binary. Covers:
 *   A  ingest → status
 *   C  export → import round-trip (replace + merge)
 *   G  install-hooks + `abs hook <event>` (snake_case payload, always exit 0)
 *
 * All against an isolated temp HOME/ABS_HOME; the real store is never touched.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abs, type E2EHome, FIXTURES_PROJECTS, makeHome, mcpClient, parseJson } from './harness.js';

interface IngestResult {
  filesProcessed: number;
  filesSkipped: number;
  observationsAdded: number;
  observationsSkipped: number;
  anchorsSeeded: number;
}
interface StatusResult {
  version: string;
  dbPath: string;
  counts: { sessions: number; observations: number; vectors: number };
  index: { stale: boolean; signature: string };
}

let h: E2EHome;
beforeEach(() => {
  h = makeHome();
});
afterEach(() => {
  h.cleanup();
});

describe('A — ingest → status', () => {
  it('ingests the fixture (skipping the isMeta turn) and status reflects real counts', async () => {
    const ing = await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
    expect(ing.code).toBe(0);
    const result = parseJson<IngestResult>(ing.stdout);
    expect(result.filesProcessed).toBeGreaterThan(0);
    // The fixture is deterministic: 3 substantive turns indexed, the 1 isMeta turn
    // skipped — proving the harness-injected turn is dropped at ingest, directly.
    expect(result.observationsAdded).toBe(3);
    expect(result.observationsSkipped).toBe(1);

    const st = await abs(['status'], { env: h.env });
    expect(st.code).toBe(0);
    const status = parseJson<StatusResult>(st.stdout);
    expect(status.counts.observations).toBe(result.observationsAdded);
    expect(status.counts.sessions).toBeGreaterThanOrEqual(1);
    // embed → persist → index parity: a vector per stored observation.
    expect(status.counts.vectors).toBe(status.counts.observations);
    expect(status.dbPath).toContain(h.absHome);
  });

  it('is idempotent — re-ingesting the same dir adds nothing new', async () => {
    await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
    const second = await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
    expect(second.code).toBe(0);
    expect(parseJson<IngestResult>(second.stdout).observationsAdded).toBe(0);
  });

  it('drops the harness-injected isMeta turn (not recallable)', async () => {
    await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
    const client = await mcpClient(h.env);
    try {
      const res = (await client.callTool({
        name: 'recall',
        arguments: { query: 'harness-injected meta turn must be skipped', limit: 10 },
      })) as { content: Array<{ text: string }> };
      const hits = JSON.parse(res.content[0]?.text ?? '[]') as Array<{ content: string }>;
      expect(hits.some((x) => x.content.includes('harness-injected meta turn'))).toBe(false);
    } finally {
      await client.close();
    }
  });
});

describe('C — export → import round-trip', () => {
  it('replace mode reproduces the original observation count in a fresh store', async () => {
    await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
    const original = parseJson<StatusResult>((await abs(['status'], { env: h.env })).stdout).counts
      .observations;
    expect(original).toBeGreaterThan(0);

    const artifact = join(h.home, 'export.json');
    const exp = await abs(['export', artifact], { env: h.env });
    expect(exp.code).toBe(0);
    expect(exp.stdout).toContain('exported');
    expect(existsSync(artifact)).toBe(true);

    const dst = makeHome();
    try {
      const imp = await abs(['import', artifact, '--mode', 'replace'], { env: dst.env });
      expect(imp.code).toBe(0);
      expect(imp.stdout).toContain('(replace)');
      const after = parseJson<StatusResult>((await abs(['status'], { env: dst.env })).stdout).counts
        .observations;
      expect(after).toBe(original);
    } finally {
      dst.cleanup();
    }
  });

  it('merge mode sums imported content onto an existing store', async () => {
    await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
    const artifactCount = parseJson<StatusResult>((await abs(['status'], { env: h.env })).stdout)
      .counts.observations;
    const artifact = join(h.home, 'export.json');
    await abs(['export', artifact], { env: h.env });

    // A destination that already holds one observation (seeded via MCP `remember`).
    const dst = makeHome();
    try {
      const client = await mcpClient(dst.env);
      await client.callTool({
        name: 'remember',
        arguments: { content: 'a pre-existing memory in the destination store', kind: 'note' },
      });
      await client.close();

      const before = parseJson<StatusResult>((await abs(['status'], { env: dst.env })).stdout)
        .counts.observations;
      expect(before).toBe(1);

      const imp = await abs(['import', artifact, '--mode', 'merge'], { env: dst.env });
      expect(imp.code).toBe(0);
      expect(imp.stdout).toContain('(merge)');
      const after = parseJson<StatusResult>((await abs(['status'], { env: dst.env })).stdout).counts
        .observations;
      expect(after).toBe(before + artifactCount);
    } finally {
      dst.cleanup();
    }
  });
});

describe('G — install-hooks + abs hook (non-fatal, always exit 0)', () => {
  /** Build a snake_case Claude Code hook payload (the only shape payload.ts reads). */
  function payload(extra: Record<string, unknown>): string {
    return JSON.stringify({ session_id: 'e2e-hook', cwd: h.home, ...extra });
  }

  it('install-hooks writes the 4 hooks into <HOME>/.claude/settings.json and is idempotent', async () => {
    const first = await abs(['install-hooks'], { env: h.env });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('registered hooks');

    const settingsPath = join(h.home, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    for (const event of ['SessionEnd', 'SessionStart', 'UserPromptSubmit', 'PreToolUse']) {
      expect(settings.hooks[event]).toBeDefined();
    }

    const second = await abs(['install-hooks'], { env: h.env });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('already present');
  });

  it('every hook event exits 0 — even with a broken store path (non-fatal contract)', async () => {
    for (const event of ['session-end', 'session-start', 'user-prompt-submit']) {
      const ok = await abs(['hook', event], {
        env: h.env,
        input: payload({ hook_event_name: event, prompt: 'anything' }),
      });
      expect(ok.code, `${event} with a healthy store`).toBe(0);
    }
    // Force an internal error path the hook must swallow: make ABS_HOME a child of a
    // regular FILE, so the store directory can never be created. abs hook must still
    // exit 0 (ADR-0004 non-fatal contract).
    const blocker = join(h.home, 'blocker-file');
    writeFileSync(blocker, 'not a directory');
    const broken = await abs(['hook', 'session-end'], {
      env: { ...h.env, ABS_HOME: join(blocker, 'abs') },
      input: payload({ hook_event_name: 'session-end' }),
    });
    expect(broken.code, 'session-end with a broken ABS_HOME still exits 0').toBe(0);
  });

  it('session-start injects baseline context once the store has observations', async () => {
    await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
    const res = await abs(['hook', 'session-start'], {
      env: h.env,
      input: payload({ hook_event_name: 'SessionStart', source: 'startup' }),
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('hookSpecificOutput');
    expect(res.stdout).toContain('additionalContext');
  });

  it('user-prompt-submit injects FTS recall when the prompt matches stored memory', async () => {
    await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
    // Global scope: this asserts the recall-injection mechanism, not project scoping
    // — the payload's session/cwd intentionally do not match the fixture's project
    // (project-scoped isolation is covered by scenario K).
    const res = await abs(['hook', 'user-prompt-submit'], {
      env: { ...h.env, ABS_RECALL_SCOPE: 'global' },
      input: payload({ hook_event_name: 'UserPromptSubmit', prompt: 'when is staging reset' }),
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('additionalContext');
  });
});

describe('K — cross-project isolation (#47)', () => {
  /** Build a two-project transcript tree under the temp HOME and ingest it. */
  function seedTwoProjects(): { projectsDir: string } {
    const root = join(h.home, 'twoproj');
    const a = join(root, 'projA');
    const b = join(root, 'projB');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(
      join(a, 'sessA.jsonl'),
      `${JSON.stringify({ type: 'user', sessionId: 'sessA', cwd: '/work/projA', message: { role: 'user', content: 'In project A the refund window is 30 days.' } })}\n`,
    );
    writeFileSync(
      join(b, 'sessB.jsonl'),
      `${JSON.stringify({ type: 'user', sessionId: 'sessB', cwd: '/work/projB', message: { role: 'user', content: 'In project B the kubernetes ingress uses nginx with TLS on 443.' } })}\n`,
    );
    return { projectsDir: root };
  }

  it('a project-A session does not recall project-B memory under project scope', async () => {
    const { projectsDir } = seedTwoProjects();
    await abs(['ingest', '--dir', projectsDir], { env: h.env });

    // Project-A session (externalId sessA → stored project "projA") asks a query
    // that only matches project B's content. Under the default project scope it
    // must recall NOTHING from project B.
    const scoped = await abs(['hook', 'user-prompt-submit'], {
      env: h.env, // ABS_RECALL_SCOPE defaults to 'project'
      input: JSON.stringify({
        session_id: 'sessA',
        cwd: '/work/projA',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'kubernetes ingress nginx TLS',
      }),
    });
    expect(scoped.code).toBe(0);
    expect(scoped.stdout).not.toContain('kubernetes');
    expect(scoped.stdout).not.toContain('TLS on 443');

    // Under global scope the same query DOES surface project B's memory.
    const global = await abs(['hook', 'user-prompt-submit'], {
      env: { ...h.env, ABS_RECALL_SCOPE: 'global' },
      input: JSON.stringify({
        session_id: 'sessA',
        cwd: '/work/projA',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'kubernetes ingress nginx TLS',
      }),
    });
    expect(global.code).toBe(0);
    expect(global.stdout).toContain('kubernetes');
  });
});
