import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // src unit tests + the OFFLINE live-harness unit tests (parser/assert), which read
    // a committed stream-json fixture and never spawn `claude`, so they belong in `check`.
    include: ['src/**/*.test.ts', 'e2e/live/**/*.test.ts'],
    environment: 'node',
    // Warm the real embedding model ONCE before the parallel workers start, so they
    // don't all race the same ~35s first-run download on a cold cache (#154).
    globalSetup: ['./vitest.global-setup.ts'],
    // Embedding/restart tests are heavier than unit tests; give them room.
    testTimeout: 60_000,
  },
});
