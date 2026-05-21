import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroundTruthProvider } from './factory.js';
import { CodeReviewGraphProvider } from './graph-provider.js';
import { NullGroundTruthProvider } from './null-provider.js';

/**
 * GroundTruthProvider port (issue #24). The graph adapter is exercised against
 * a hand-built minimal graph.db that mirrors the real nodes schema, so the test
 * needs no external code-review-graph install.
 */

/** Build a minimal code-review-graph DB at repoRoot/.code-review-graph/graph.db. */
function seedGraph(repoRoot: string): void {
  const graphDir = join(repoRoot, '.code-review-graph');
  mkdirSync(graphDir, { recursive: true });
  const db = new Database(join(graphDir, 'graph.db'));
  const ddl = [
    'CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, line_start INTEGER)',
    'CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)',
  ];
  for (const stmt of ddl) db.prepare(stmt).run();
  const node = db.prepare(
    'INSERT INTO nodes (id, kind, name, qualified_name, file_path, line_start) VALUES (?, ?, ?, ?, ?, ?)',
  );
  node.run(1, 'Function', 'foo', 'mod.foo', '/repo/src/mod.ts', 42);
  node.run(2, 'Class', 'Bar', 'mod.Bar', '/repo/src/mod.ts', 10);
  node.run(3, 'File', '/repo/src/mod.ts', '/repo/src/mod.ts', '/repo/src/mod.ts', null);
  db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('commit', 'deadbeef');
  db.close();
}

describe('GroundTruthProvider', () => {
  describe('NullGroundTruthProvider (degradation)', () => {
    it('is unavailable and resolves everything to null without throwing', () => {
      const p = new NullGroundTruthProvider();
      expect(p.isAvailable()).toBe(false);
      expect(p.resolveSymbol('anything')).toBeNull();
      expect(p.resolveFile('/x.ts')).toBeNull();
      p.close();
    });
  });

  describe('CodeReviewGraphProvider', () => {
    let dir: string;
    let repoRoot: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'abs-gt-'));
      repoRoot = join(dir, 'repo');
      seedGraph(repoRoot);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('is available and resolves a symbol with file:line@commit', () => {
      const p = new CodeReviewGraphProvider(repoRoot);
      expect(p.isAvailable()).toBe(true);
      const r = p.resolveSymbol('foo');
      expect(r).toEqual({
        qualifiedName: 'mod.foo',
        filePath: '/repo/src/mod.ts',
        line: 42,
        commitSha: 'deadbeef',
      });
      p.close();
    });

    it('returns null for a missing symbol (fail-open, no throw)', () => {
      const p = new CodeReviewGraphProvider(repoRoot);
      expect(p.resolveSymbol('ghost')).toBeNull();
      p.close();
    });

    it('resolves a file node', () => {
      const p = new CodeReviewGraphProvider(repoRoot);
      expect(p.resolveFile('/repo/src/mod.ts')?.filePath).toBe('/repo/src/mod.ts');
      expect(p.resolveFile('/repo/src/ghost.ts')).toBeNull();
      p.close();
    });

    it('is unavailable when the graph db is absent', () => {
      const p = new CodeReviewGraphProvider(join(dir, 'no-such-repo'));
      expect(p.isAvailable()).toBe(false);
      expect(p.resolveSymbol('foo')).toBeNull();
      p.close();
    });
  });

  describe('factory', () => {
    it('returns NullGroundTruthProvider when repoRoot is undefined', () => {
      expect(createGroundTruthProvider(undefined)).toBeInstanceOf(NullGroundTruthProvider);
    });

    it('returns NullGroundTruthProvider when no graph db exists', () => {
      const dir = mkdtempSync(join(tmpdir(), 'abs-gt-factory-'));
      expect(createGroundTruthProvider(dir)).toBeInstanceOf(NullGroundTruthProvider);
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns CodeReviewGraphProvider when a graph db exists', () => {
      const root = mkdtempSync(join(tmpdir(), 'abs-gt-factory-'));
      seedGraph(root);
      expect(createGroundTruthProvider(root)).toBeInstanceOf(CodeReviewGraphProvider);
      rmSync(root, { recursive: true, force: true });
    });
  });
});
