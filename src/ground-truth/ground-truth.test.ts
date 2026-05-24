import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AbsIndexProvider } from './abs-index-provider.js';
import { createGroundTruthProvider } from './factory.js';
import { NullGroundTruthProvider } from './null-provider.js';

describe('createGroundTruthProvider', () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('returns AbsIndexProvider inside a git repo', () => {
    const repo = mkdtempSync(join(tmpdir(), 'abs-fac-'));
    tmps.push(repo);
    execFileSync('git', ['-C', repo, 'init', '-q']);
    expect(createGroundTruthProvider(repo)).toBeInstanceOf(AbsIndexProvider);
  });

  it('returns the Null provider outside a git repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'abs-nogit-'));
    tmps.push(plain);
    expect(createGroundTruthProvider(plain)).toBeInstanceOf(NullGroundTruthProvider);
  });

  it('returns Null for an undefined cwd', () => {
    expect(createGroundTruthProvider(undefined)).toBeInstanceOf(NullGroundTruthProvider);
  });
});
