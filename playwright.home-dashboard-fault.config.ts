import { defineConfig } from 'playwright/test';
import { BASE_URL, serverEnv } from './tests/integration/home-dashboard-fault.fixture';

/**
 * Dedicated, self-contained Playwright config for U43 (C/C-12) — the
 * home-dashboard "missing cards" fix's induced-failure proof (BINARY
 * acceptance (a)). Mirrors playwright.create-task.config.ts's /
 * playwright.agent-navigation.config.ts's pattern: stands up its OWN Next
 * dev server against a throwaway DB + workspace, with the interview
 * shell-lock pre-satisfied, so the fault-injection → degraded-slot →
 * recovery sequence is proven against the REAL UI + REAL fetch/retry loop —
 * not a mock of the pure decision logic (already covered by
 * tests/unit/p1-03-dashboard-workspaces.test.ts).
 *
 * Kept separate from the other integration configs so none of the suites'
 * dedicated dev servers collide.
 *
 * Run with: npm run test:e2e:home-dashboard-fault
 */
export default defineConfig({
  testDir: './tests/integration',
  testMatch: /home-dashboard-fault\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './tests/integration/home-dashboard-fault.global-setup.ts',
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
