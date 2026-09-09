import { defineConfig } from 'playwright/test';

/**
 * Playwright config for the F27 social-theme mini app E2E (QC-F27 browser
 * half). Isolated from the shared smoke config: dedicated port, isolated
 * throwaway DB, controlled env so the exchange → wizard → submit happy path
 * is deterministic. Skips cleanly when the infra cannot boot (the runner
 * records NOT VERIFIED rather than failing the workflow).
 *
 * Run: npx playwright test --config=playwright.social-theme.config.ts
 */

const baseURL = process.env.SOCIAL_THEME_BASE_URL || 'http://localhost:4127';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /social-theme\.spec\.ts$/,
  outputDir: './test-results/social-theme-browser',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: 'npm run dev',
    url: `${baseURL}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PORT: '4127',
      DATABASE_PATH: './.test-social-theme-f27.db',
      MC_TENANT_SESSION_SECRET: 'f27-e2e-secret',
      MC_API_TOKEN: 'f27-e2e-operator-token',
      MC_INSTALLATION_ID: 'f27-e2e-install',
      MC_TENANT_PUBLIC_URL: 'http://localhost:4127',
      NODE_ENV: 'development',
      OWNER_NOTIFY_TELEGRAM_DISABLED: '1',
    },
  },
});