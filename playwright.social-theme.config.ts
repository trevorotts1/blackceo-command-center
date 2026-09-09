import { defineConfig } from 'playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Fresh persistent fixture per run. Workers inherit this exact root. This
// config never connects to a client service or skips a failed acceptance gate.
const port = process.env.SOCIAL_THEME_E2E_PORT || '4127';
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('Invalid E2E port');
const baseURL = `http://127.0.0.1:${port}`;
process.env.SOCIAL_THEME_E2E_RUN_ROOT ||= mkdtempSync(path.join(tmpdir(), 'cc-social-e2e-'));
process.env.SOCIAL_THEME_BASE_URL = baseURL;

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
  use: { baseURL, headless: true, screenshot: 'only-on-failure', trace: 'off', video: 'off' },
  webServer: {
    command: 'node scripts/social-theme-e2e-server.cjs',
    url: `${baseURL}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe', stderr: 'pipe',
    env: { SOCIAL_THEME_E2E_RUN_ROOT: process.env.SOCIAL_THEME_E2E_RUN_ROOT, SOCIAL_THEME_E2E_PORT: port },
  },
});
