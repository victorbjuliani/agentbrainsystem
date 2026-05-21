/**
 * Vitest global setup for the E2E suite. Runs ONCE before any scenario.
 *
 *  1. Guard: the suite drives the BUILT binary, so `dist/cli/cli.js` must exist.
 *     Fail loudly with the fix command rather than letting every scenario fail.
 *  2. Pre-flight: warm the local embedding model cache by ingesting the fixture
 *     into a throwaway home. On a machine that already has the model cached (the
 *     common case) this is a fast no-op; on a cold machine it downloads once
 *     (~35s) so the actual scenarios run from cache. This is the ONLY step allowed
 *     to touch the network — the offline guarantee is "cache is warm", established
 *     here.
 */
import { existsSync } from 'node:fs';
import { abs, CLI, FIXTURES_PROJECTS, makeHome } from './harness.js';

export default async function setup(): Promise<void> {
  if (!existsSync(CLI)) {
    throw new Error(
      `E2E suite needs the built binary at ${CLI}. Run \`npm run build\` first ` +
        '(npm run test:e2e does this automatically).',
    );
  }

  const h = makeHome();
  try {
    // Ingest embeds every observation → forces the model load/download exactly once.
    const res = await abs(['ingest', '--dir', FIXTURES_PROJECTS], {
      env: h.env,
      timeoutMs: 180_000, // generous: a cold machine downloads the model here
    });
    if (res.code !== 0) {
      throw new Error(
        `E2E pre-flight (model cache warm-up) failed.\nstdout:${res.stdout}\nstderr:${res.stderr}`,
      );
    }
  } finally {
    h.cleanup();
  }
}
