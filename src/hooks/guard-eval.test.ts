import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refreshIndex } from '../index/indexer.js';
import { type Memory, openMemory } from '../memory.js';
import { evaluateGuard, type GuardCase } from './guard-eval.js';

function git(root: string, ...args: string[]) {
  execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
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
    mkdirSync(join(repo, 'src'), { recursive: true });
    delete process.env.ABS_GUARD_MODE;
    process.env.ABS_HOME = join(dir, 'abs');
    process.env.ABS_EMBED_DIM = '8';
    process.env.ABS_WASM_DIR = join(__dirname, '../../dist/index/wasm');
    // Native ground truth: the three existing symbols live in src/existing.ts.
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(
      join(repo, 'src/existing.ts'),
      'export function existingA(){}\nexport function existingB(){}\nexport class existingC {}\n',
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'seed');
    await refreshIndex(repo);
    emptyMemory = await openMemory(undefined, { ensure: false });
  });

  afterEach(() => {
    emptyMemory.close();
    delete process.env.ABS_HOME;
    delete process.env.ABS_EMBED_DIM;
    delete process.env.ABS_WASM_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  /** A representative labelled set: 3 genuine duplications + 7 benign actions. */
  function buildCases(): GuardCase[] {
    const f = (name: string) => join(repo, name);
    return [
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
    const result = await evaluateGuard(
      buildCases(),
      { fpPerActionMax: 0 },
      { memory: emptyMemory },
    );
    expect(result.passesGate).toBe(false);
  });
});
