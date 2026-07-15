import { defineConfig } from 'playwright/test';
import { BASE_URL, serverEnv } from './tests/integration/agent-navigation.fixture';

/**
 * Dedicated, self-contained Playwright config for the U58 agent-navigation
 * click-through proof (QC fix-loop, BINARY acceptance 5). Mirrors
 * playwright.create-task.config.ts's pattern: stands up its OWN Next dev
 * server against a throwaway DB + workspace, with the interview shell-lock
 * pre-satisfied, so "click an agent row on the CEO board, land on that
 * agent's own performance detail page" can be proven against the REAL UI —
 * not a mock.
 *
 * Kept separate from the other dedicated suites (different fixture,
 * different port) so none of them collide.
 *
 * Run with: npm run test:e2e:agent-navigation
 */
export default defineConfig({
  testDir: './tests/integration',
  testMatch: /agent-navigation\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './tests/integration/agent-navigation.global-setup.ts',
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
