import { defineConfig } from 'playwright/test';

/**
 * Playwright config for v4.0 integration smoke tests.
 *
 * Depth 3 Track D. The smoke suite assumes a running dev server. Override the
 * base URL with V4_BASE_URL when targeting a non-default port. Each test
 * probes the server in beforeAll and skips cleanly if nothing is listening,
 * so the suite is safe to run in CI without standing up Next first.
 */

const baseURL = process.env.V4_BASE_URL || 'http://localhost:4000';

export default defineConfig({
  testDir: './tests/integration',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
