import { defineConfig } from 'playwright/test';
import { BASE_URL, serverEnv } from './tests/integration/my-ai-ceo-responsive.fixture';

/**
 * P5-01 responsive-proof config for the My AI CEO surface + board + TaskModal
 * at 360/768/1280.
 *
 * Unlike the original version of this config (which assumed an
 * already-running dev server on :4000 and skipped cleanly when nothing was
 * listening), this STANDS UP its own Next dev server with a controlled
 * fixture workspace (mirrors playwright.interview-lock.config.ts /
 * playwright.create-task.config.ts) so the responsive proof is produced
 * deterministically in CI, not skipped:
 *   • OPENCLAW_WORKSPACE_ROOT → a throwaway fixture (never ~/.openclaw), so
 *     the interview gate resolves complete without touching real state.
 *   • MC_INTERVIEW_COOKIE_SECRET pinned so signer + Edge verifier agree.
 *   • A dedicated port (4125) so it never collides with the smoke (4000),
 *     interview-lock (4123), or create-task (4124) servers.
 *
 * Kept separate from the other three configs on purpose (each spec needs its
 * own fixture/port). Run it with: npm run test:e2e:my-ai-ceo
 */
export default defineConfig({
  testDir: './tests/integration',
  testMatch: /my-ai-ceo-responsive\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './tests/integration/my-ai-ceo-responsive.global-setup.ts',
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'off',
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
