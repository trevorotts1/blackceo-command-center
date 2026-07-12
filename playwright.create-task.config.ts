import { defineConfig } from 'playwright/test';
import { BASE_URL, serverEnv } from './tests/integration/create-task.fixture';

/**
 * Dedicated, self-contained Playwright config for the P2-03 create-task
 * regression lock. Mirrors playwright.interview-lock.config.ts's pattern:
 * stands up its OWN Next dev server against a throwaway DB + workspace, with
 * the interview shell-lock pre-satisfied, so "click New Task, submit, see it
 * in Backlog" can be proven deterministically against the REAL UI + REAL API
 * route + REAL DB — not a mock.
 *
 * Kept separate from playwright.config.ts (which assumes an already-running
 * smoke server) and from playwright.interview-lock.config.ts (different
 * fixture, different port) so none of the three suites collide.
 *
 * Run with: npm run test:e2e:create-task
 */
export default defineConfig({
  testDir: './tests/integration',
  testMatch: /create-task\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './tests/integration/create-task.global-setup.ts',
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'npm run dev',
    url: `${BASE_URL}/api/health`,
    env: serverEnv(),
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
