import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests/integration',
  testMatch: 'prior-completion-proof.spec.ts',
  outputDir: './test-results/prior-completion-proof/browser',
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
