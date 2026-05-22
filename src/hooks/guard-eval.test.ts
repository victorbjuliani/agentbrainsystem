import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Memory, openMemory } from '../memory.js';
import { evaluateGuard, type GuardCase } from './guard-eval.js';

/** Seed a graph whose existing symbols live in `src/existing.ts`. */
function seedGraph(repoRoot: string, symbols: string[]): void {
  const graphDir = join(repoRoot, '.code-review-graph');
  mkdirSync(graphDir, { recursive: true });
  const db = new Database(join(graphDir, 'graph.db'));
  db.prepare(
    'CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, line_start INTEGER)',
  ).run();
  const ins = db.prepare(
    'INSERT INTO nodes (id, kind, name, qualified_name, file_path, line_start) VALUES (?, ?, ?, ?, ?, ?)',
  );
  let i = 1;
  for (const name of symbols) {
    ins.run(i, 'Function', name, name, join(repoRoot, 'src/existing.ts'), i * 3);
    i++;
  }
  db.close();
}

describe('guard evaluation harness (#30, O3 gate)', () => {
  let dir: string;
  let repo: string;
  // An empty store injected so the warn-only decision-surfacing lens (#48 Phase A)
  // stays silent — the O3 gate measures the block-eligible duplication lens only.
  let emptyMemory: Memory;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'abs-guardeval-'));
    repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    delete process.env.ABS_GUARD_MODE;
    process.env.ABS_HOME = join(dir, 'abs');
    process.env.ABS_EMBED_DIM = '8';
    seedGraph(repo, ['existingA', 'existingB', 'existingC']);
    emptyMemory = await openMemory(undefined, { ensure: false });
  });

  afterEach(() => {
    emptyMemory.close();
    delete process.env.ABS_HOME;
    delete process.env.ABS_EMBED_DIM;
    rmSync(dir, { recursive: true, force: true });
  });

  /** A representative labelled set: 3 genuine duplications + 7 benign actions. */
  function buildCases(): GuardCase[] {
    const f = (name: string) => join(repo, name);
    return [
      // --- bad: redefining an existing symbol in a NEW file (true contradiction) ---
      {
        name: 'dup existingA',
        shouldFire: true,
        payload: {
          cwd: repo,
          toolName: 'Write',
          toolInput: { file_path: f('src/dupe1.ts'), content: 'export function existingA() {}' },
        },
      },
      {
        name: 'dup existingB',
        shouldFire: true,
        payload: {
          cwd: repo,
          toolName: 'Write',
          toolInput: { file_path: f('src/dupe2.ts'), content: 'function existingB() {}' },
        },
      },
      {
        name: 'dup existingC via Edit',
        shouldFire: true,
        payload: {
          cwd: repo,
          toolName: 'Edit',
          toolInput: { file_path: f('src/dupe3.ts'), new_string: 'class existingC {}' },
        },
      },
      // --- benign: should NOT fire ---
      {
        name: 'edit existing in its own file',
        shouldFire: false,
        payload: {
          cwd: repo,
          toolName: 'Edit',
          toolInput: {
            file_path: f('src/existing.ts'),
            new_string: 'export function existingA() { return 1; }',
          },
        },
      },
      {
        name: 'brand new symbol',
        shouldFire: false,
        payload: {
          cwd: repo,
          toolName: 'Write',
          toolInput: { file_path: f('src/fresh.ts'), content: 'export function brandNew() {}' },
        },
      },
      {
        name: 'non-code file',
        shouldFire: false,
        payload: {
          cwd: repo,
          toolName: 'Write',
          toolInput: { file_path: f('README.md'), content: '# existingA' },
        },
      },
      {
        name: 'bash command',
        shouldFire: false,
        payload: { cwd: repo, toolName: 'Bash', toolInput: { command: 'rm existingA' } },
      },
      {
        name: 'edit with no new symbol',
        shouldFire: false,
        payload: {
          cwd: repo,
          toolName: 'Edit',
          toolInput: { file_path: f('src/other.ts'), new_string: '  return total + 1;' },
        },
      },
      {
        name: 'read',
        shouldFire: false,
        payload: { cwd: repo, toolName: 'Read', toolInput: { file_path: f('src/existing.ts') } },
      },
      {
        name: 'new file new symbols only',
        shouldFire: false,
        payload: {
          cwd: repo,
          toolName: 'Write',
          toolInput: {
            file_path: f('src/more.ts'),
            content: 'function totallyNew() {}\nfunction alsoNew() {}',
          },
        },
      },
    ];
  }

  it('meets the O3 release gate: TP >= 30% AND FP < 1 per 10 actions', async () => {
    const result = await evaluateGuard(buildCases(), {}, { memory: emptyMemory });
    // This guard is precise: every seeded duplication is caught, zero false alarms.
    expect(result.tpRate).toBe(1);
    expect(result.fpPerAction).toBe(0);
    expect(result.passesGate).toBe(true);
  });

  it('reports the underlying counts for the release artifact', async () => {
    const result = await evaluateGuard(buildCases(), {}, { memory: emptyMemory });
    expect(result.badCases).toBe(3);
    expect(result.benignCases).toBe(7);
    expect(result.truePositives).toBe(3);
    expect(result.falsePositives).toBe(0);
  });

  it('flags a gate failure when FP is too high (sanity of the metric itself)', async () => {
    // A pathological set where every benign action is mislabelled "should fire"
    // would still measure fpPerAction against true labels — here we prove the
    // gate math rejects a noisy guard by tightening the threshold to 0.
    const result = await evaluateGuard(
      buildCases(),
      { fpPerActionMax: 0 },
      { memory: emptyMemory },
    );
    // fpPerAction is 0, and the gate uses strict <, so max=0 fails by construction.
    expect(result.passesGate).toBe(false);
  });
});
