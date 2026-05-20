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
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

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
