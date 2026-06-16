/**
 * Vitest global setup for the default (`npm run check`) suite. Runs ONCE, serially,
 * before the parallel worker pool starts.
 *
 * Why: `vitest run` executes the suite across parallel worker processes (forks).
 * Several files use the REAL local embedding model (Xenova/all-MiniLM-L6-v2). On a
 * cold cache — e.g. CI, which caches npm but NOT transformers.js's model cache —
 * every one of those workers races to trigger the same ~35s first-run download at
 * once; the contention blows the 60s testTimeout and surfaces as flaky failures
 * (notably the opencode capture→recall tests persisting 0 observations → an empty
 * `<recalled-memory>`). See issue #154.
 *
 * Warming the model here populates the on-disk cache once; the workers then load from
 * a warm cache (~280ms). Mirrors `e2e/global-setup.ts`. On a warm machine this is a
 * fast load. If it fails (e.g. offline with no cache) we log and continue rather than
 * aborting the whole suite — the few real-model tests then fail with their own clear
 * errors instead of a confusing empty-recall assertion.
 */
import { LocalEmbeddingProvider } from './src/embedding/local.js';

export default async function setup(): Promise<void> {
  const started = Date.now();
  try {
    // embed() forces the pipeline load (download on a cold cache) + one inference,
    // fully populating the transformers.js cache the workers will read.
    await new LocalEmbeddingProvider().embed(['warmup']);
    process.stdout.write(`[vitest] embedding model warm (${Date.now() - started}ms)\n`);
  } catch (err) {
    process.stderr.write(
      `[vitest] embedding model warm-up failed (${(err as Error).message}); ` +
        'real-model tests may be slow or flaky\n',
    );
  }
}
