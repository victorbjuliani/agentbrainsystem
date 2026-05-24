import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The native symbol index reads its wasm from dist/index/wasm at runtime. `npm run check`
// runs `pretest` (build:ui = scripts/build-ui.mjs) which copies them, so they exist here.
describe('grammar wasm bundling', () => {
  const dist = resolve(__dirname, '../../dist/index/wasm');
  it('ships the core + grammar wasms', () => {
    for (const f of [
      'tree-sitter.wasm',
      'tree-sitter-typescript.wasm',
      'tree-sitter-tsx.wasm',
      'tree-sitter-javascript.wasm',
      'tree-sitter-python.wasm',
    ]) {
      expect(existsSync(resolve(dist, f)), f).toBe(true);
    }
  });
});
