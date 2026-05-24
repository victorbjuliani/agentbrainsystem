#!/usr/bin/env node
/**
 * Bundle the browser client for the memory-graph UI (issue #11).
 *
 * Pipeline:
 *   src/ui/client/main.ts  --esbuild-->  dist/ui/static/app.js   (ESM, minified)
 *   (main.ts imports app.css)        ->  dist/ui/static/app.css
 *   @fontsource woff2/woff           ->  dist/ui/static/fonts/*  (self-hosted, no CDN)
 *   src/ui/client/index.html         ->  dist/ui/static/index.html  (copied verbatim)
 *
 * Self-hosting rationale: the `file` loader rewrites every `url(./files/*.woff2)`
 * in the @fontsource CSS to `fonts/<name>` and emits the asset, so the shipped
 * CSS references fonts locally — the UI works fully offline (ADR 0002).
 *
 * Idempotent: re-running overwrites the outputs. Creates dirs as needed.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = resolve(root, 'src/ui/client');
const outDir = resolve(root, 'dist/ui/static');

await mkdir(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(clientDir, 'main.ts')],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  outdir: outDir,
  entryNames: 'app',
  // main.ts imports app.css, so esbuild emits dist/ui/static/app.css alongside app.js.
  loader: {
    '.css': 'css',
    '.woff2': 'file',
    '.woff': 'file',
  },
  // Emit font assets under fonts/ and rewrite CSS url() references to point there.
  assetNames: 'fonts/[name]',
  logLevel: 'info',
});

// Static HTML shell — copied verbatim (no templating).
await cp(resolve(clientDir, 'index.html'), resolve(outDir, 'index.html'));

console.log(`UI bundled → ${outDir}`);

// Bundle the tree-sitter core + grammar wasm for the native symbol index (src/index).
// Resolve via each package dir (its package.json IS exported) and join the known files;
// throw if any is missing so a version-pin drift is loud, not a silent empty index.
const wasmOut = resolve(root, 'dist/index/wasm');
await mkdir(wasmOut, { recursive: true });
const wtsDir = dirname(require.resolve('web-tree-sitter/package.json'));
const grammarsDir = resolve(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
const wasmCopies = [[resolve(wtsDir, 'tree-sitter.wasm'), 'tree-sitter.wasm']];
for (const g of ['typescript', 'tsx', 'javascript', 'python']) {
  wasmCopies.push([resolve(grammarsDir, `tree-sitter-${g}.wasm`), `tree-sitter-${g}.wasm`]);
}
for (const [src, name] of wasmCopies) {
  if (!existsSync(src)) throw new Error(`grammar wasm missing: ${src} (version pin drift?)`);
  await cp(src, resolve(wasmOut, name));
}
console.log(`index wasm bundled → ${wasmOut}`);
