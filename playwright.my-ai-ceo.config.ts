import { defineConfig } from 'playwright/test';

/**
 * P5-01 responsive-proof config for the My AI CEO surface + board at 360/768/1280.
 *
 * Mirrors the base playwright.config.ts pattern: assumes an already-running dev
 * server (override with V4_BASE_URL), each test probes /api/health in beforeAll
 * and skips cleanly if nothing is listening. Kept separate from the other three
 * configs so the suites never collide.
 *
 * Run with: npm run test:e2e:my-ai-ceo
 */
const baseURL = process.env.V4_BASE_URL || 'http://localhost:4000';

export default defineConfig({
  testDir: './tests/integration',
  testMatch: /my-ai-ceo-responsive\.spec\.ts$/,
  timeout: 45_000,
  expect: { timeout: 8_000 },
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
