import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Embedding/restart tests are heavier than unit tests; give them room.
    testTimeout: 60_000,
  },
});
