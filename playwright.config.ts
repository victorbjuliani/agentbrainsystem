import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the UI E2E (`e2e/*.pw.ts`). Distinct match glob from the
 * Vitest E2E (`*.e2e.ts`) so the two runners never pick up each other's files.
 * Artifacts land under `e2e/.tmp/` (gitignored) to keep `git status` clean — a
 * stated success criterion of the suite. The UI server is spawned per-test by the
 * harness (isolated temp HOME), so there is no `webServer` block here.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.pw.ts',
  outputDir: 'e2e/.tmp/pw-output',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    headless: true,
    trace: 'off',
  },
});
