import { defineConfig } from 'playwright/test';
import { BASE_URL, serverEnv } from './tests/integration/interview-lock.fixture';

/**
 * Dedicated, self-contained Playwright config for the interview-mode shell-lock
 * E2E (WG-6 / WG-10c command-center half).
 *
 * Unlike playwright.config.ts (which assumes an already-running smoke server and
 * skips cleanly when none is up), this config STANDS UP its own Next dev server
 * with a controlled fixture workspace so the lock can be proven deterministically
 * in CI:
 *   • OPENCLAW_WORKSPACE_ROOT → a throwaway fixture (never ~/.openclaw), so the
 *     Node cookie-setter derives completion from a build-state WE seed.
 *   • MC_INTERVIEW_COOKIE_SECRET pinned so signer + Edge verifier agree.
 *   • A dedicated port (4123) so it never collides with the port-4000 smoke run.
 *
 * Kept separate from the shared config on purpose: adding a webServer to
 * playwright.config.ts would force every integration spec to build/boot a server
 * and defeat their skip-when-not-live design. Run it with:
 *   npm run test:e2e:interview-lock
 */
export default defineConfig({
  testDir: './tests/integration',
  testMatch: /interview-lock\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Flake control in CI: a first-request `next dev` compile or a fire-and-forget
  // cookie-setter race can occasionally lose a poll. Retry twice in CI (never
  // locally, so a real regression fails fast for the author). Serial + 1 worker
  // keeps the shared fixture build-state deterministic across retries.
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './tests/integration/interview-lock.global-setup.ts',
  use: {
    baseURL: BASE_URL,
    headless: true,
    // Capture a full Playwright trace + screenshot only when a test is retried
    // after a failure, so green runs stay cheap but any CI flake/regression is
    // debuggable from the uploaded artifact.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    // `next dev -p ${PORT:-4000}` — PORT is supplied via env below.
    command: 'npm run dev',
    url: `${BASE_URL}/api/health`,
    env: serverEnv(),
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
