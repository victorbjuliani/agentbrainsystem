import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../embedding/index.js';
import { handleSessionEnd } from '../hooks/session-end.js';
import { Indexer } from '../indexer/index.js';
import type { Memory } from '../memory.js';
import { projectSlug } from '../optimize/targets.js';
import { Recall } from '../recall/index.js';
import { MemoryStore } from '../store/index.js';
import { ingestClaudeProjects, ingestSingleSession, surveyClaudeProjects } from './ingest.js';
import { writeBinding } from './session-binding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Deterministic, offline provider so ingestion tests run without a model download. */
class FakeProvider implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-v1';
  readonly dimensions = 8;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vec(t));
  }
  private vec(t: string): number[] {
    const v = new Array(this.dimensions).fill(0) as number[];
    for (let i = 0; i < t.length; i++) {
      v[i % this.dimensions] = (v[i % this.dimensions] ?? 0) + t.charCodeAt(i);
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}

let dir: string;
let projectsDir: string;

/** Build a Memory-shaped object wired to a temp store + the fake provider. */
function newMemory(): Memory {
  const store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: 8 }).open();
  const provider = new FakeProvider();
  const indexer = new Indexer(store, provider);
  const recall = new Recall(store, provider);
  return { store, provider, indexer, recall, close: () => store.close() };
}

/** A Claude Code transcript entry with a string `content` (user style). */
function userLine(sessionId: string, cwd: string, text: string, uuid: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    cwd,
    uuid,
    timestamp: '2026-05-20T10:00:00.000Z',
    message: { role: 'user', content: text },
  });
}

/** A Claude Code transcript entry with block-array `content` (assistant style). */
function assistantLine(
  sessionId: string,
  cwd: string,
  blocks: Array<Record<string, unknown>>,
  uuid: string,
): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    cwd,
    uuid,
    timestamp: '2026-05-20T10:01:00.000Z',
    message: { role: 'assistant', content: blocks },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-ingest-'));
  projectsDir = join(dir, 'projects');
  mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ingestClaudeProjects — first ingest', () => {
  it('creates observations and sessions from a fake projects tree', async () => {
    const projDir = join(projectsDir, '-Users-me-Devs-foo');
    mkdirSync(projDir, { recursive: true });
    const file = join(projDir, 'session.jsonl');
    writeFileSync(
      file,
      [
        userLine('sess-1', '/Users/me/Devs/foo', 'how do I run the tests', 'u1'),
        assistantLine(
          'sess-1',
          '/Users/me/Devs/foo',
          [
            { type: 'thinking', thinking: 'internal reasoning here', signature: 'sig' },
            { type: 'text', text: 'run npm test from the repo root' },
          ],
          'a1',
        ),
        '   ', // whitespace-only line -> skipped
        '{ not valid json', // malformed -> skipped
        assistantLine(
          'sess-1',
          '/Users/me/Devs/foo',
          [{ type: 'tool_use', name: 'Bash', input: {} }],
          'a2',
        ), // tool-only -> no extractable text, skipped
        '',
      ].join('\n'),
    );

    const memory = newMemory();
    const result = await ingestClaudeProjects(memory, { projectsDir });

    expect(result.filesProcessed).toBe(1);
    expect(result.observationsAdded).toBe(2);
    expect(result.observationsSkipped).toBe(3); // whitespace + malformed + tool-only

    const session = memory.store.getSessionByExternalId('sess-1');
    expect(session).not.toBeNull();
    expect(session?.project).toBe('-Users-me-Devs-foo');

    const obs = memory.store.listObservations({ sessionId: session?.id });
    expect(obs).toHaveLength(2);
    const user = obs.find((o) => o.kind === 'user');
    const asst = obs.find((o) => o.kind === 'assistant');
    expect(user?.content).toBe('how do I run the tests');
    expect(asst?.content).toBe('run npm test from the repo root');
    expect(user?.source).toBe(file);
    expect(user?.metadata).toMatchObject({ uuid: 'u1' });
    expect(user?.createdAt).toBe('2026-05-20T10:00:00.000Z');

    memory.close();
  });

  it('recall finds an ingested observation via knn', async () => {
    const projDir = join(projectsDir, '-Users-me-Devs-bar');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 's.jsonl'),
      userLine('sess-x', '/Users/me/Devs/bar', 'kangaroo elephant zebra', 'u1'),
    );

    const memory = newMemory();
    await ingestClaudeProjects(memory, { projectsDir });

    const [q] = await memory.provider.embed(['kangaroo elephant zebra']);
    const hits = memory.store.knn(q as number[], 1);
    const obs = hits[0] ? memory.store.getObservation(hits[0].id) : null;
    expect(obs?.content).toBe('kangaroo elephant zebra');

    memory.close();
  });
});

describe('ingestClaudeProjects — incremental', () => {
  it('re-ingest is a no-op (cursor → observationsAdded === 0)', async () => {
    const projDir = join(projectsDir, '-Users-me-Devs-foo');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 's.jsonl'),
      [
        userLine('sess-1', '/Users/me/Devs/foo', 'first message', 'u1'),
        assistantLine(
          'sess-1',
          '/Users/me/Devs/foo',
          [{ type: 'text', text: 'first reply' }],
          'a1',
        ),
      ].join('\n'),
    );

    const memory = newMemory();
    const first = await ingestClaudeProjects(memory, { projectsDir });
    expect(first.observationsAdded).toBe(2);
    expect(first.filesProcessed).toBe(1);

    const second = await ingestClaudeProjects(memory, { projectsDir });
    expect(second.observationsAdded).toBe(0);
    expect(second.filesProcessed).toBe(0);
    expect(second.filesSkipped).toBe(1);

    expect(memory.store.counts().observations).toBe(2);
    memory.close();
  });

  it('appending new lines then re-ingesting picks up only the new ones', async () => {
    const projDir = join(projectsDir, '-Users-me-Devs-foo');
    mkdirSync(projDir, { recursive: true });
    const file = join(projDir, 's.jsonl');
    writeFileSync(file, `${userLine('sess-1', '/Users/me/Devs/foo', 'msg one', 'u1')}\n`);

    const memory = newMemory();
    const first = await ingestClaudeProjects(memory, { projectsDir });
    expect(first.observationsAdded).toBe(1);

    appendFileSync(
      file,
      `${assistantLine('sess-1', '/Users/me/Devs/foo', [{ type: 'text', text: 'msg two' }], 'a1')}\n`,
    );

    const second = await ingestClaudeProjects(memory, { projectsDir });
    expect(second.observationsAdded).toBe(1);
    expect(second.filesProcessed).toBe(1);
    expect(memory.store.counts().observations).toBe(2);

    const session = memory.store.getSessionByExternalId('sess-1');
    const obs = memory.store.listObservations({ sessionId: session?.id });
    expect(obs.map((o) => o.content).sort()).toEqual(['msg one', 'msg two']);
    memory.close();
  });

  it('skips files entirely when nothing changed and counts them as skipped', async () => {
    const projDir = join(projectsDir, '-Users-me-Devs-foo');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'a.jsonl'),
      userLine('sess-a', '/Users/me/Devs/foo', 'alpha', 'u1'),
    );
    writeFileSync(join(projDir, 'b.jsonl'), userLine('sess-b', '/Users/me/Devs/foo', 'beta', 'u1'));

    const memory = newMemory();
    await ingestClaudeProjects(memory, { projectsDir });
    const second = await ingestClaudeProjects(memory, { projectsDir });
    expect(second.filesSkipped).toBe(2);
    expect(second.observationsAdded).toBe(0);
    memory.close();
  });
});

describe('ingestClaudeProjects — project from cwd, not storage dir', () => {
  it('derives the project from entry.cwd, so a subagent transcript lands in the parent project (not "subagents")', async () => {
    // A subagent transcript lives at <project>/<uuid>/subagents/agent.jsonl, so
    // basename(dirname) is the literal "subagents". Its cwd, however, is the
    // parent project's real working dir — that is the correct project.
    const subDir = join(projectsDir, '-Users-me-Devs-foo', 'uuid-123', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent.jsonl'),
      userLine('sub-sess', '/Users/me/Devs/foo', 'subagent did some work', 'u1'),
    );

    const memory = newMemory();
    await ingestClaudeProjects(memory, { projectsDir });

    const s = memory.store.getSessionByExternalId('sub-sess');
    expect(s?.project).toBe('-Users-me-Devs-foo'); // cwd-derived, NOT 'subagents'
    memory.close();
  });

  it('canonicalizes the same cwd stored under two differently-encoded dirs into one project', async () => {
    // Old Claude Code encoding preserved spaces/underscores; the new one hyphenates
    // everything. Both dirs map to the SAME real cwd → must resolve to one project.
    const cwd = '/Users/me/Meu Mac/demo-corp';
    const oldDir = join(projectsDir, '-Users-me-Meu Mac-demo-corp');
    const newDir = join(projectsDir, '-Users-me-Meu-Mac-demo-corp');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, 's-old.jsonl'), userLine('sess-old', cwd, 'old transcript', 'u1'));
    writeFileSync(join(newDir, 's-new.jsonl'), userLine('sess-new', cwd, 'new transcript', 'u1'));

    const memory = newMemory();
    await ingestClaudeProjects(memory, { projectsDir });

    const projects = memory.store.listProjects();
    expect(projects).toEqual(['-Users-me-Meu Mac-demo-corp']); // one canonical project
    memory.close();
  });

  it('falls back to the storage dir name when entry.cwd is absent', async () => {
    const projDir = join(projectsDir, '-Users-me-Devs-nocwd');
    mkdirSync(projDir, { recursive: true });
    // A line with no cwd field (older transcript) — keep the legacy behavior.
    writeFileSync(
      join(projDir, 's.jsonl'),
      JSON.stringify({
        type: 'user',
        sessionId: 'sess-nocwd',
        uuid: 'u1',
        timestamp: '2026-05-20T10:00:00.000Z',
        message: { role: 'user', content: 'no cwd here' },
      }),
    );

    const memory = newMemory();
    await ingestClaudeProjects(memory, { projectsDir });

    expect(memory.store.getSessionByExternalId('sess-nocwd')?.project).toBe('-Users-me-Devs-nocwd');
    memory.close();
  });
});

describe('ingestClaudeProjects — missing tree', () => {
  it('returns an empty tally when the projects dir does not exist', async () => {
    const memory = newMemory();
    const result = await ingestClaudeProjects(memory, {
      projectsDir: join(dir, 'does-not-exist'),
    });
    expect(result).toEqual({
      filesProcessed: 0,
      filesSkipped: 0,
      observationsAdded: 0,
      observationsSkipped: 0,
      anchorsSeeded: 0,
    });
    memory.close();
  });
});

describe('ingestClaudeProjects — anchor seeding (#25)', () => {
  function writeSession(blocks: Array<Record<string, unknown>>[]): Memory {
    const projDir = join(projectsDir, '-Users-me-Devs-foo');
    mkdirSync(projDir, { recursive: true });
    const lines = blocks.map((b, i) => assistantLine('sess-1', '/Users/me/Devs/foo', b, `a${i}`));
    writeFileSync(join(projDir, 'session.jsonl'), lines.join('\n'));
    return newMemory();
  }

  it('seeds a file anchor and per-symbol anchors from an Edit with prose', async () => {
    const memory = writeSession([
      [
        { type: 'text', text: 'Adding the helper.' },
        {
          type: 'tool_use',
          name: 'Edit',
          input: {
            file_path: '/Users/me/Devs/foo/src/mod.ts',
            new_string: 'export function helper() {}',
          },
        },
      ],
    ]);
    const result = await ingestClaudeProjects(memory, { projectsDir });
    expect(result.observationsAdded).toBe(1); // the prose turn
    expect(result.anchorsSeeded).toBe(2); // file + symbol(helper)

    const obs = memory.store.listObservations()[0];
    const anchors = memory.store.getAnchorsForObservation(obs?.id ?? -1);
    expect(anchors.map((a) => a.anchorKind).sort()).toEqual(['file', 'symbol']);
    expect(anchors.every((a) => a.state === 'claimed')).toBe(true);
    expect(memory.store.findAnchorsBySymbol('helper')).toHaveLength(1);
    expect(memory.store.findAnchorsByFile('/Users/me/Devs/foo/src/mod.ts')).toHaveLength(2);
    memory.close();
  });

  it('creates a compact tool_edit observation for an Edit-only turn', async () => {
    const memory = writeSession([
      [
        {
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '/Users/me/Devs/foo/src/a.py', content: 'class Foo:\n    pass' },
        },
      ],
    ]);
    const result = await ingestClaudeProjects(memory, { projectsDir });
    expect(result.observationsAdded).toBe(1);
    expect(result.anchorsSeeded).toBe(2); // file + symbol(Foo)
    const obs = memory.store.listObservations()[0];
    expect(obs?.kind).toBe('tool_edit');
    expect(obs?.content).toContain('src/a.py');
    memory.close();
  });

  it('ignores Read and non-code Edits (no anchors, turn skipped if textless)', async () => {
    const memory = writeSession([
      [{ type: 'tool_use', name: 'Read', input: { file_path: '/Users/me/Devs/foo/src/mod.ts' } }],
      [
        {
          type: 'tool_use',
          name: 'Edit',
          input: { file_path: '/Users/me/Devs/foo/README.md', new_string: '# docs' },
        },
      ],
    ]);
    const result = await ingestClaudeProjects(memory, { projectsDir });
    expect(result.observationsAdded).toBe(0); // both textless + non-anchorable → skipped
    expect(result.anchorsSeeded).toBe(0);
    memory.close();
  });
});

describe('ingestClaudeProjects — decision-aware (#50)', () => {
  /** Write a one-session transcript file under a cwd-derived project dir. */
  function writeTranscript(projectDir: string, fileName: string, lines: string[]): string {
    const projDir = join(projectsDir, projectDir);
    mkdirSync(projDir, { recursive: true });
    const file = join(projDir, fileName);
    writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  }

  it('NO binding → byte-for-byte the cwd-derived project (zero regression)', async () => {
    writeTranscript('-Users-me-Devs-foo', 'sess-1.jsonl', [
      userLine('sess-1', '/Users/me/Devs/foo', 'hello world', 'u1'),
    ]);
    const memory = newMemory();
    const result = await ingestClaudeProjects(memory, { projectsDir });
    expect(result.observationsAdded).toBe(1);
    expect(memory.store.getSessionByExternalId('sess-1')?.project).toBe('-Users-me-Devs-foo');
    memory.close();
  });

  it('SET binding written before ingest → session created with the chosen project', async () => {
    writeTranscript('-Users-me-Devs-foo', 'sess-1.jsonl', [
      userLine('sess-1', '/Users/me/Devs/foo', 'hello world', 'u1'),
    ]);
    const memory = newMemory();
    expect(writeBinding(memory.store, 'sess-1', { action: 'set', project: 'Travelpoints' })).toBe(true);

    const result = await ingestClaudeProjects(memory, { projectsDir });
    expect(result.observationsAdded).toBe(1);
    const s = memory.store.getSessionByExternalId('sess-1');
    expect(s?.project).toBe('Travelpoints'); // override, NOT '-Users-me-Devs-foo'
    expect(memory.store.counts().sessions).toBe(1);
    memory.close();
  });

  it('SET binding after a prior auto-ingest → next run UPDATEs the project (Risk #2)', async () => {
    const file = writeTranscript('-Users-me-Devs-foo', 'sess-1.jsonl', [
      userLine('sess-1', '/Users/me/Devs/foo', 'first', 'u1'),
    ]);
    const memory = newMemory();

    // Run 1: no binding → auto project, row created.
    await ingestClaudeProjects(memory, { projectsDir });
    expect(memory.store.getSessionByExternalId('sess-1')?.project).toBe('-Users-me-Devs-foo');

    // User decides the project AFTER the row already exists; a new line arrives.
    writeBinding(memory.store, 'sess-1', { action: 'set', project: 'Widget' });
    appendFileSync(
      file,
      `${assistantLine('sess-1', '/Users/me/Devs/foo', [{ type: 'text', text: 'second' }], 'a1')}\n`,
    );

    // Run 2: grown file → the existing row's project is UPDATEd, not duplicated.
    const second = await ingestClaudeProjects(memory, { projectsDir });
    expect(second.observationsAdded).toBe(1);
    expect(memory.store.getSessionByExternalId('sess-1')?.project).toBe('Widget');
    expect(memory.store.counts().sessions).toBe(1);
    expect(memory.store.counts().observations).toBe(2);
    memory.close();
  });

  it('SKIP binding before ingest → no session, no observations, cursor still advances', async () => {
    writeTranscript('-Users-me-Devs-junk', 'sess-2.jsonl', [
      userLine('sess-2', '/Users/me/Devs/junk', 'throwaway one', 'u1'),
      assistantLine(
        'sess-2',
        '/Users/me/Devs/junk',
        [{ type: 'text', text: 'throwaway two' }],
        'a1',
      ),
    ]);
    const memory = newMemory();
    writeBinding(memory.store, 'sess-2', { action: 'skip' });

    const first = await ingestClaudeProjects(memory, { projectsDir });
    expect(first.observationsAdded).toBe(0);
    expect(first.observationsSkipped).toBe(2);
    expect(first.filesProcessed).toBe(1);
    expect(memory.store.getSessionByExternalId('sess-2')).toBeNull();
    expect(memory.store.counts().sessions).toBe(0);
    expect(memory.store.counts().observations).toBe(0);

    // Cursor advanced to EOF → a re-run skips the file entirely (no re-ingest loop).
    const second = await ingestClaudeProjects(memory, { projectsDir });
    expect(second.filesProcessed).toBe(0);
    expect(second.filesSkipped).toBe(1);
    expect(second.observationsAdded).toBe(0);
    memory.close();
  });

  it('at-least-once: SKIP after a session was already fully ingested → reconciled away', async () => {
    // Models the abrupt-Ctrl-C window: SessionEnd did not fire to apply the
    // decision, but ingest already ran once. The binding is the durable carrier.
    writeTranscript('-Users-me-Devs-junk', 'sess-3.jsonl', [
      userLine('sess-3', '/Users/me/Devs/junk', 'oops stored this', 'u1'),
    ]);
    const memory = newMemory();

    // It got ingested first.
    await ingestClaudeProjects(memory, { projectsDir });
    expect(memory.store.counts().observations).toBe(1);

    // Then the user marks it skip — writeBinding reconciles the already-stored row.
    writeBinding(memory.store, 'sess-3', { action: 'skip' });
    expect(memory.store.getSessionByExternalId('sess-3')).toBeNull();
    expect(memory.store.counts().observations).toBe(0);
    memory.close();
  });

  it('at-least-once: SET written while offline, applied whenever ingest next runs', async () => {
    const file = writeTranscript('-Users-me-Devs-foo', 'sess-4.jsonl', [
      userLine('sess-4', '/Users/me/Devs/foo', 'line one', 'u1'),
    ]);
    const memory = newMemory();

    // Decision recorded BEFORE any ingest (SessionEnd may never have fired).
    writeBinding(memory.store, 'sess-4', { action: 'set', project: 'Chosen' });
    // More lines accrue, then ingest finally runs.
    appendFileSync(
      file,
      `${assistantLine('sess-4', '/Users/me/Devs/foo', [{ type: 'text', text: 'line two' }], 'a1')}\n`,
    );

    const result = await ingestClaudeProjects(memory, { projectsDir });
    expect(result.observationsAdded).toBe(2);
    expect(memory.store.getSessionByExternalId('sess-4')?.project).toBe('Chosen');
    memory.close();
  });
});

describe('opt-in / scoped ingest (#62)', () => {
  /** Lay down two projects, each with one transcript, and return their paths. */
  function twoProjectTree(): { aFile: string; bFile: string } {
    const aDir = join(projectsDir, '-Users-me-A');
    const bDir = join(projectsDir, '-Users-me-B');
    mkdirSync(aDir, { recursive: true });
    mkdirSync(bDir, { recursive: true });
    const aFile = join(aDir, 'sa.jsonl');
    const bFile = join(bDir, 'sb.jsonl');
    writeFileSync(aFile, `${userLine('sa', '/Users/me/A', 'alpha question', 'ua')}\n`);
    writeFileSync(bFile, `${userLine('sb', '/Users/me/B', 'beta question', 'ub')}\n`);
    return { aFile, bFile };
  }

  it('ingestSingleSession ingests ONLY the given transcript, not its siblings', async () => {
    const { aFile } = twoProjectTree();
    const memory = newMemory();
    const result = await ingestSingleSession(memory, aFile);

    expect(result.filesProcessed).toBe(1);
    expect(result.observationsAdded).toBe(1);
    expect(memory.store.getSessionByExternalId('sa')).not.toBeNull();
    expect(memory.store.getSessionByExternalId('sb')).toBeNull(); // sibling untouched
    memory.close();
  });

  it('ingestSingleSession on a missing file is a safe no-op', async () => {
    const memory = newMemory();
    const result = await ingestSingleSession(memory, join(projectsDir, 'gone', 'nope.jsonl'));
    expect(result.observationsAdded).toBe(0);
    expect(result.filesProcessed).toBe(0);
    memory.close();
  });

  it('ingestClaudeProjects restricts the walk to the chosen project slugs', async () => {
    twoProjectTree();
    const memory = newMemory();
    const result = await ingestClaudeProjects(memory, {
      projectsDir,
      projects: ['-Users-me-A'],
    });

    expect(result.observationsAdded).toBe(1);
    expect(memory.store.getSessionByExternalId('sa')).not.toBeNull();
    expect(memory.store.getSessionByExternalId('sb')).toBeNull(); // project B excluded
    memory.close();
  });

  it('surveyClaudeProjects groups by project with new/total counts and writes nothing', async () => {
    twoProjectTree();
    const memory = newMemory();

    const before = await surveyClaudeProjects(memory, { projectsDir });
    expect(before).toEqual([
      { project: '-Users-me-A', transcripts: 1, newTranscripts: 1 },
      { project: '-Users-me-B', transcripts: 1, newTranscripts: 1 },
    ]);
    // Survey is read-only — nothing was ingested.
    expect(memory.store.getSessionByExternalId('sa')).toBeNull();

    // After ingesting A, its transcript is no longer "new"; B still is.
    await ingestClaudeProjects(memory, { projectsDir, projects: ['-Users-me-A'] });
    const after = await surveyClaudeProjects(memory, { projectsDir });
    expect(after.find((p) => p.project === '-Users-me-A')?.newTranscripts).toBe(0);
    expect(after.find((p) => p.project === '-Users-me-B')?.newTranscripts).toBe(1);
    memory.close();
  });
});

describe('Codex ingest (per-format seam, W4/C1, #67)', () => {
  const CODEX_UUID = '019e2658-c8b0-7230-9b59-c3646fbf0c7b';
  const codexRel =
    '.codex/sessions/2026/05/14/rollout-2026-05-14T08-56-53-019e2658-c8b0-7230-9b59-c3646fbf0c7b.jsonl';
  const CWD = '/Users/me/proj';
  const META = JSON.stringify({
    type: 'session_meta',
    payload: { id: CODEX_UUID, cwd: CWD, originator: 'Codex', cli_version: '0.125.0' },
  });
  const u = (text: string) =>
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
  const a = (text: string) =>
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    });

  it('ingests a Codex rollout via ingestSingleSession: one codex:-namespaced session, prose obs', async () => {
    const memory = newMemory();
    const src = join(__dirname, '__fixtures__/codex/rollout-sample.jsonl');
    const codexPath = join(dir, codexRel);
    mkdirSync(dirname(codexPath), { recursive: true });
    copyFileSync(src, codexPath);
    const result = await ingestSingleSession(memory, codexPath);
    expect(result.observationsAdded).toBeGreaterThan(0);
    const sessions = memory.store.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.externalId).toBe(`codex:${CODEX_UUID}`); // W1 namespaced
    memory.close();
  });

  it('the REAL dispatch path (handleSessionEnd) namespaces a Codex transcript codex:, Claude stays bare (C1)', async () => {
    const memory = newMemory();
    const codexPath = join(dir, codexRel);
    mkdirSync(dirname(codexPath), { recursive: true });
    copyFileSync(join(__dirname, '__fixtures__/codex/rollout-sample.jsonl'), codexPath);
    const claudePath = join(projectsDir, '-Users-me-foo/sess.jsonl');
    mkdirSync(dirname(claudePath), { recursive: true });
    writeFileSync(claudePath, `${userLine('claude-sess', '/Users/me/foo', 'hello', 'u1')}\n`);
    await handleSessionEnd(
      { transcriptPath: codexPath },
      { ingest: (p) => ingestSingleSession(memory, p).then(() => undefined) },
    );
    await handleSessionEnd(
      { transcriptPath: claudePath },
      { ingest: (p) => ingestSingleSession(memory, p).then(() => undefined) },
    );
    const ids = memory.store
      .listSessions()
      .map((s) => s.externalId)
      .sort();
    expect(ids).toEqual(['claude-sess', `codex:${CODEX_UUID}`]);
    memory.close();
  });

  it('a second Stop on a GROWN Codex rollout appends only new turns — no re-insert of prior turns (W4)', async () => {
    const memory = newMemory();
    const codexPath = join(dir, codexRel);
    mkdirSync(dirname(codexPath), { recursive: true });
    // Turn 1: header + one user/assistant pair.
    writeFileSync(codexPath, `${[META, u('turn one q'), a('turn one a')].join('\n')}\n`);
    await ingestSingleSession(memory, codexPath);
    const afterTurn1 = memory.store.counts().observations;
    expect(afterTurn1).toBe(2);
    // Turn 2: append a second pair (NO new header — header-less tail).
    appendFileSync(codexPath, `${[u('turn two q'), a('turn two a')].join('\n')}\n`);
    await ingestSingleSession(memory, codexPath);
    const afterTurn2 = memory.store.counts().observations;
    // Only the NEW turn's observations were added (cursor resumed past turn 1).
    expect(afterTurn2).toBe(afterTurn1 + 2);
    expect(memory.store.listSessions().length).toBe(1); // still one codex: session
    // Project derived from the cached header cwd, even on the header-less resume.
    expect(memory.store.listSessions()[0]?.project).not.toBe('2026-05-14');
    memory.close();
  });
});

describe('Gemini ingest (whole-file JSON, id-watermark + .project_root, #68)', () => {
  const GEM_UUID = '78432a44-385f-41f6-8a71-646d51996f8a';
  const REAL_CWD = '/Users/me/Devs/agentbrainsystem';
  const doc = (msgs: object[]) =>
    JSON.stringify({
      sessionId: GEM_UUID,
      projectHash: 'h',
      startTime: 't',
      lastUpdated: 't',
      messages: msgs,
      kind: 'main',
    });
  const userMsg = (i: number) => ({
    id: `u${i}`,
    timestamp: 't',
    type: 'user',
    content: [{ text: `q${i}` }],
  });
  const asstMsg = (i: number) => ({
    id: `a${i}`,
    timestamp: 't',
    type: 'gemini',
    content: [{ text: `r${i}` }],
  });
  const m = (id: string, type: 'user' | 'gemini', text: string) => ({
    id,
    timestamp: 't',
    type,
    content: [{ text }],
  });

  it('a second SessionEnd on a GROWN Gemini file ingests only the new message, under the REAL project (id watermark + .project_root, never "chats")', async () => {
    const memory = newMemory();
    const slugDir = join(dir, '.gemini/tmp/agentbrainsystem');
    const geminiPath = join(slugDir, 'chats/session-2026-05-23T04-24-78432a44.json');
    mkdirSync(dirname(geminiPath), { recursive: true });
    writeFileSync(join(slugDir, '.project_root'), REAL_CWD); // C-NEW-1 marker

    // SessionEnd #1 — a 2-message file → exactly 2 observations, REAL project.
    writeFileSync(geminiPath, doc([userMsg(1), asstMsg(1)]));
    await ingestSingleSession(memory, geminiPath);
    expect(memory.store.counts().observations).toBe(2);
    const sess = memory.store.listSessions();
    expect(sess.length).toBe(1);
    expect(sess[0]?.externalId).toBe(`gemini:${GEM_UUID}`);
    expect(sess[0]?.project).toBe(projectSlug(REAL_CWD)); // real cwd, NOT 'chats'
    expect(sess[0]?.project).not.toBe('chats');

    // Gemini REWRITES THE WHOLE FILE with a 3rd message appended. SessionEnd #2.
    writeFileSync(geminiPath, doc([userMsg(1), asstMsg(1), userMsg(2)]));
    await ingestSingleSession(memory, geminiPath);
    expect(memory.store.counts().observations).toBe(3); // +1 ONLY — not +3
    expect(memory.store.listSessions().length).toBe(1);

    // Idempotent: a SessionEnd on the UNCHANGED file adds nothing.
    await ingestSingleSession(memory, geminiPath);
    expect(memory.store.counts().observations).toBe(3);
    memory.close();
  });

  it('a /rewind that truncates + regrows is RE-SYNCED, never silently dropped (W-NEW-1)', async () => {
    const memory = newMemory();
    const slugDir = join(dir, '.gemini/tmp/agentbrainsystem');
    const geminiPath = join(slugDir, 'chats/session-2026-05-23T04-24-78432a44.json');
    mkdirSync(dirname(geminiPath), { recursive: true });
    writeFileSync(join(slugDir, '.project_root'), REAL_CWD);

    // Ingest 3 prose messages → 3 obs. Last id watermarked = 'm3'.
    writeFileSync(
      geminiPath,
      doc([m('m1', 'user', 'q1'), m('m2', 'gemini', 'r1'), m('m3', 'user', 'q2')]),
    );
    await ingestSingleSession(memory, geminiPath);
    expect(memory.store.counts().observations).toBe(3);

    // /rewind to m1 (drops m2,m3) THEN add 2 NEW messages with NEW ids. The
    // watermarked 'm3' is GONE → must re-sync, NOT skip (a count watermark of 3
    // would see length 3 and add NOTHING — silent drop).
    writeFileSync(
      geminiPath,
      doc([m('m1', 'user', 'q1'), m('m4', 'gemini', 'r2'), m('m5', 'user', 'q3')]),
    );
    await ingestSingleSession(memory, geminiPath);
    expect(memory.store.counts().observations).toBeGreaterThanOrEqual(3); // NO silent drop
    expect(memory.store.counts().observations).toBe(6); // re-synced whole file
    expect(memory.store.searchFts('q3', 10).length).toBeGreaterThan(0); // new turn landed
    expect(memory.store.listSessions().length).toBe(1);
    memory.close();
  });

  it('NOTE-1: a Gemini file with NO .project_root marker buckets under the slug dir, never "chats"', async () => {
    const memory = newMemory();
    const slugDir = join(dir, '.gemini/tmp/agentbrainsystem');
    const geminiPath = join(slugDir, 'chats/session-2026-05-23T04-24-78432a44.json');
    mkdirSync(dirname(geminiPath), { recursive: true });
    // NO .project_root written → fallback to the slug dir name.
    writeFileSync(geminiPath, doc([userMsg(1), asstMsg(1)]));
    await ingestSingleSession(memory, geminiPath);
    const sess = memory.store.listSessions();
    expect(sess.length).toBe(1);
    expect(sess[0]?.project).toBe('agentbrainsystem'); // slug dir, not 'chats'
    expect(sess[0]?.project).not.toBe('chats');
    memory.close();
  });
});

describe('Copilot ingest (byte cursor + compaction guard, #69)', () => {
  const CO_UUID = '3db5c133-d9b9-419c-a649-d8d1b0514c49';
  const copilotRel = `.copilot/session-state/${CO_UUID}/events.jsonl`;
  const CWD = '/Users/me/Devs/agentbrainsystem';
  const ctx = JSON.stringify({
    id: 'evt-ctx',
    timestamp: 't',
    type: 'session.context_changed',
    data: { cwd: CWD },
  });
  const u = (id: string, text: string) =>
    JSON.stringify({ id, timestamp: 't', type: 'user.message', data: { content: text } });
  const a = (id: string, text: string) =>
    JSON.stringify({ id, timestamp: 't', type: 'assistant.message', data: { content: text } });

  it('ingests the Copilot fixture via ingestSingleSession: one copilot:-namespaced session under the real cwd project', async () => {
    const memory = newMemory();
    const src = join(__dirname, '__fixtures__/copilot-events.jsonl');
    const copilotPath = join(dir, copilotRel);
    mkdirSync(dirname(copilotPath), { recursive: true });
    copyFileSync(src, copilotPath);
    const result = await ingestSingleSession(memory, copilotPath);
    expect(result.observationsAdded).toBeGreaterThan(0);
    const sessions = memory.store.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.externalId).toBe(`copilot:${CO_UUID}`); // W1 namespaced
    expect(sessions[0]?.project).toBe(projectSlug(CWD)); // real cwd, not the dir UUID
    expect(sessions[0]?.project).not.toBe(CO_UUID);
    memory.close();
  });

  it('the REAL dispatch path (handleSessionEnd) namespaces a Copilot transcript copilot: (C1)', async () => {
    const memory = newMemory();
    const copilotPath = join(dir, copilotRel);
    mkdirSync(dirname(copilotPath), { recursive: true });
    copyFileSync(join(__dirname, '__fixtures__/copilot-events.jsonl'), copilotPath);
    await handleSessionEnd(
      { transcriptPath: copilotPath },
      { ingest: (p) => ingestSingleSession(memory, p).then(() => undefined) },
    );
    const ids = memory.store.listSessions().map((s) => s.externalId);
    expect(ids).toEqual([`copilot:${CO_UUID}`]);
    memory.close();
  });

  it('a second SessionEnd on a GROWN events.jsonl appends only new turns (byte cursor at EOF)', async () => {
    const memory = newMemory();
    const copilotPath = join(dir, copilotRel);
    mkdirSync(dirname(copilotPath), { recursive: true });
    writeFileSync(
      copilotPath,
      `${[ctx, u('e1', 'turn one q'), a('e2', 'turn one a')].join('\n')}\n`,
    );
    await ingestSingleSession(memory, copilotPath);
    const afterTurn1 = memory.store.counts().observations;
    expect(afterTurn1).toBe(2);
    // Append a new pair (no new context event — header-less tail).
    appendFileSync(copilotPath, `${[u('e3', 'turn two q'), a('e4', 'turn two a')].join('\n')}\n`);
    await ingestSingleSession(memory, copilotPath);
    expect(memory.store.counts().observations).toBe(afterTurn1 + 2);
    expect(memory.store.listSessions().length).toBe(1);
    // An UNCHANGED-file re-ingest adds nothing (cursor at EOF).
    await ingestSingleSession(memory, copilotPath);
    expect(memory.store.counts().observations).toBe(afterTurn1 + 2);
    memory.close();
  });

  it('a compaction/fork truncate-to-shorter-prefix + new tail is RE-SYNCED, NEVER silently dropped (the cursor>size guard in ingestOneTranscript)', async () => {
    const memory = newMemory();
    const copilotPath = join(dir, copilotRel);
    mkdirSync(dirname(copilotPath), { recursive: true });
    // Ingest 3 events → cursor at EOF (a large offset).
    writeFileSync(
      copilotPath,
      `${[ctx, u('e1', 'q1'), a('e2', 'r1'), u('e3', 'q2')].join('\n')}\n`,
    );
    await ingestSingleSession(memory, copilotPath);
    const afterFirst = memory.store.counts().observations;
    expect(afterFirst).toBeGreaterThan(0);
    const sizeAfterFirst = readFileSync(copilotPath, 'utf8').length;

    // Compaction: rewrite to a STRICT PREFIX shorter than the cursor, then append a
    // NEW tail. A count/byte cursor >= size would SKIP this file → silent drop of
    // the tail. The guard must reset to 0 and re-ingest.
    const truncated = `${[ctx, u('e1', 'q1')].join('\n')}\n`; // strict prefix, shorter
    const newTail = `${a('e9', 'brand new tail answer')}\n`;
    writeFileSync(copilotPath, truncated + newTail);
    const sizeAfterCompaction = (truncated + newTail).length;
    expect(sizeAfterCompaction).toBeLessThan(sizeAfterFirst); // file shrank → cursor > size

    await ingestSingleSession(memory, copilotPath);
    // No crash, file was NOT skipped: the new tail landed.
    expect(memory.store.searchFts('brand new tail answer', 10).length).toBeGreaterThan(0);
    expect(memory.store.listSessions().length).toBe(1);
    // Cursor advanced to the NEW (smaller) EOF.
    const cursor = Number.parseInt(
      memory.store.getMeta(`ingest:cursor:${copilotPath}`) ?? '-1',
      10,
    );
    expect(cursor).toBe(Buffer.byteLength(truncated + newTail, 'utf8'));
    memory.close();
  });
});
