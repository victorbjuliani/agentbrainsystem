import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refreshIndex } from '../index/indexer.js';
import { AbsIndexProvider } from './abs-index-provider.js';

function git(root: string, ...a: string[]) {
  execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
}

describe('AbsIndexProvider', () => {
  let home: string;
  let repo: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'abs-piH-'));
    process.env.ABS_HOME = home;
    process.env.ABS_WASM_DIR = join(__dirname, '../../dist/index/wasm');
    repo = mkdtempSync(join(tmpdir(), 'abs-piR-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'export function foo(){}\nexport class Bar{}');
    writeFileSync(join(repo, 'note.rs'), 'fn rusty() {}');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    await refreshIndex(repo);
  });
  afterEach(() => {
    delete process.env.ABS_HOME;
    delete process.env.ABS_WASM_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('resolves a symbol in its file (absolute path back)', () => {
    const p = new AbsIndexProvider(repo);
    expect(p.resolveSymbol('foo', { filePath: join(repo, 'a.ts') })?.filePath).toBe(
      join(repo, 'a.ts'),
    );
    p.close();
  });
  it('resolves a symbol cross-file when filePath is omitted', () => {
    const p = new AbsIndexProvider(repo);
    expect(p.resolveSymbol('Bar')?.filePath).toBe(join(repo, 'a.ts'));
    p.close();
  });
  it('returns null for a genuinely absent symbol in a SUPPORTED file (→ stale)', () => {
    const p = new AbsIndexProvider(repo);
    expect(p.resolveSymbol('ghost', { filePath: join(repo, 'a.ts') })).toBeNull();
    p.close();
  });
  it('NEVER stales an UNSUPPORTED-language file: returns a file-level match', () => {
    const p = new AbsIndexProvider(repo);
    const r = p.resolveSymbol('rusty', { filePath: join(repo, 'note.rs') });
    expect(r).not.toBeNull();
    expect(r?.filePath).toBe(join(repo, 'note.rs'));
    p.close();
  });
  it('resolveFile: existing resolves, missing is null', () => {
    const p = new AbsIndexProvider(repo);
    expect(p.resolveFile(join(repo, 'a.ts'))).not.toBeNull();
    expect(p.resolveFile(join(repo, 'gone.ts'))).toBeNull();
    p.close();
  });
  it('unique: an ambiguous bare name resolves to null', async () => {
    writeFileSync(join(repo, 'b.ts'), 'export function foo(){}');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'dup');
    await refreshIndex(repo);
    const p = new AbsIndexProvider(repo);
    expect(p.resolveSymbol('foo', { unique: true })).toBeNull();
    p.close();
  });
});
