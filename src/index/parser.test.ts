import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Definition, initParser, parseDefinitions } from './parser.js';

const FX = join(__dirname, '__fixtures__');
const names = (defs: Definition[] | null) => (defs ?? []).map((d) => d.name).sort();

describe('parseDefinitions', () => {
  beforeAll(async () => {
    // Tests run from src/; point the parser at the built wasm in dist/ (mirror STATIC_DIR).
    process.env.ABS_WASM_DIR = resolve(__dirname, '../../dist/index/wasm');
    await initParser();
  });

  it('extracts TS function/class/method/const-arrow/interface/type names', async () => {
    const src = readFileSync(join(FX, 'sample.ts'), 'utf8');
    expect(names(await parseDefinitions('sample.ts', src))).toEqual([
      'Beta',
      'Eps',
      'Zeta',
      'alpha',
      'delta',
      'gamma',
    ]);
  });

  it('extracts Python function/class/method names', async () => {
    const src = readFileSync(join(FX, 'sample.py'), 'utf8');
    expect(names(await parseDefinitions('sample.py', src))).toEqual(['Beta', 'alpha', 'gamma']);
  });

  it('returns null for an unsupported extension (Rust)', async () => {
    expect(await parseDefinitions('main.rs', 'fn main() {}')).toBeNull();
  });

  it('returns [] for a supported file with no definitions', async () => {
    expect(await parseDefinitions('empty.ts', 'const x = 1;')).toEqual([]);
  });

  it('does not throw on a syntax error (tree-sitter is error-tolerant)', async () => {
    expect(await parseDefinitions('broken.ts', 'function (')).not.toBeNull();
  });

  it('a supported file with a real definition parses NON-null with >=1 def (ABI canary)', async () => {
    const defs = await parseDefinitions('canary.ts', 'export function canary(){}');
    expect(defs).not.toBeNull();
    expect((defs ?? []).length).toBeGreaterThan(0);
  });

  it('reports a 1-based line for a definition', async () => {
    const defs = (await parseDefinitions('one.ts', '\nexport function solo() {}')) ?? [];
    expect(defs.find((d) => d.name === 'solo')?.line).toBe(2);
  });
});
