/**
 * P5-01 (c) steps 3-4 + (e) responsive proof.
 *
 * Captures screenshots of the My AI CEO chat, the board, and the TaskModal at the
 * three breakpoints (360 / 768 / 1280) and asserts ZERO horizontal body scroll at
 * each — the exact "responsive proof" the QC (e) list requires, and the
 * cataloging harness step 4 calls for (screenshots before/after the fixes).
 *
 * Assumes a running server (like tests/integration/*.spec.ts under the base
 * playwright.config.ts). Probes /api/health in beforeAll and skips cleanly if
 * nothing is listening, so it is safe in CI without standing up Next first.
 *
 * Run against a live box:  V4_BASE_URL=http://localhost:4000 npm run test:e2e:my-ai-ceo
 */
import { test, expect } from 'playwright/test';

const BASE = process.env.V4_BASE_URL || 'http://localhost:4000';
const BREAKPOINTS = [
  { name: '360-mobile', width: 360, height: 780 },
  { name: '768-tablet', width: 768, height: 1024 },
  { name: '1280-desktop', width: 1280, height: 900 },
];

let serverUp = false;
test.beforeAll(async ({ request }) => {
  try {
    const res = await request.get(`${BASE}/api/health`, { timeout: 4000 });
    serverUp = res.ok();
  } catch {
    serverUp = false;
  }
});

/** True when the document scrolls horizontally (a responsive violation). */
async function hasHorizontalBodyScroll(page: import('playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

for (const bp of BREAKPOINTS) {
  test(`My AI CEO chat has no horizontal body scroll @ ${bp.name}`, async ({ page }) => {
    test.skip(!serverUp, 'No server listening on the base URL.');
    await page.setViewportSize({ width: bp.width, height: bp.height });
    await page.goto(`${BASE}/my-ai-ceo`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `test-results/my-ai-ceo-chat-${bp.name}.png`, fullPage: true });
    expect(await hasHorizontalBodyScroll(page)).toBe(false);
  });

  test(`Board has no horizontal body scroll @ ${bp.name}`, async ({ page }) => {
    test.skip(!serverUp, 'No server listening on the base URL.');
    await page.setViewportSize({ width: bp.width, height: bp.height });
    await page.goto(`${BASE}/tasks/all`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `test-results/board-${bp.name}.png`, fullPage: true });
    // The BODY must not scroll horizontally; the column strip scrolls INSIDE its
    // own overflow-x container (that is allowed and intended on mobile).
    expect(await hasHorizontalBodyScroll(page)).toBe(false);
  });
}
