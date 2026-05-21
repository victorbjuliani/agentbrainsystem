import { defineConfig } from 'vitest/config';

/**
 * E2E system suite — drives the BUILT binary, MCP stdio, hooks, optimize, delete
 * (NOT the localhost UI; that runs under Playwright on `*.pw.ts`). Kept OUT of the
 * default `vitest.config.ts` (`src/**`) so `npm run check` stays fast. Run via
 * `npm run test:e2e` (which builds first).
 */
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    environment: 'node',
    globalSetup: ['e2e/global-setup.ts'],
    // Each scenario spawns real processes and embeds with the local model.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Serialize: scenarios spawn servers/embedders; parallel files contend on
    // CPU and ports and make timing flaky. Correctness over wall-clock here.
    fileParallelism: false,
  },
});
