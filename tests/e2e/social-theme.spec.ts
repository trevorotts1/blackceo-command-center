/**
 * tests/e2e/social-theme.spec.ts — F27 minimal happy path (QC-F27 browser
 * half): operator mints an invitation → client opens the link → exchange
 * strips the raw token from the URL → wizard autosaves → submit shows the
 * receipt. A failed invitation or unavailable server fails acceptance; no required
 * scenario is silently skipped.
 */

import { test, expect } from '@playwright/test';

const OPERATOR_BASE = process.env.SOCIAL_THEME_BASE_URL || 'http://localhost:4127';

test.describe('social-theme mini app (F27)', () => {
  test('invitation → exchange → autosave → submit receipt', async ({ request, page }) => {
    // The workflow proves the infra boots first; the webServer fixture above
    // starts it. If /api/health never came up, webServer already failed the
    // run — here we only proceed on a live server.

    const res = await request.post(`${OPERATOR_BASE}/api/social-theme/invitations`, {
      headers: { authorization: 'Bearer f27-e2e-operator-token' },
      data: { company_id: 'self', week_start_local: '2026-09-07', timezone: 'UTC' },
    });
    expect(res.status(), 'Invitation issuance is a required acceptance gate').toBe(200);
    const invitation = (await res.json()) as { url: string };

    const ticket = new URL(invitation.url).searchParams.get('ticket') || '';
    expect(ticket.length).toBeGreaterThan(20);

    // Open the welcome screen — it exchanges and strips the raw token.
    // The dedicated mini-app route is reachable without an interview bypass.
    await page.goto(`/social-theme/welcome?ticket=${encodeURIComponent(ticket)}`);
    await expect(page.getByTestId('enter-planner')).toBeVisible({ timeout: 20_000 });
    // Raw token must be gone from the address bar.
    expect(page.url()).not.toContain('ticket=');

    await page.getByTestId('enter-planner').click();
    await expect(page.getByTestId('step-welcome')).toBeVisible();

    // Walk to theme step and autosave an answer.
    await page.getByRole('button', { name: /Start this week|Resume where you left off/ }).click();
    await expect(page.getByTestId('theme-input')).toBeVisible();
    await page.getByTestId('theme-input').fill('E2E autumn theme');
    await page.getByTestId('goal-select').selectOption('leads');
    await expect(page.getByTestId('save-badge')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

    // Offer + audience. (Scoped to the step section — the dev overlay's
    // "Open Next.js Dev Tools" button also matches a bare role query.)
    const nextInStep = (testId: string) =>
      page.getByTestId(testId).getByRole('button', { name: 'Next' });
    await nextInStep('step-theme').click();
    await expect(page.getByTestId('offer-input')).toBeVisible();
    await page.getByTestId('offer-input').fill('Fall bundle through Oct 31');
    await nextInStep('step-offer').click();
    await expect(page.getByTestId('assets-input')).toBeVisible();
    await nextInStep('step-assets').click();
    await expect(page.getByTestId('step-review')).toBeVisible();

    // Submit once, receipt visible.
    await page.getByTestId('submit-button').click();
    await expect(page.getByTestId('submit-receipt')).toBeVisible({ timeout: 20_000 });
  });
});
// Real HTTP + browser proof of the two boundaries most likely to lose a client
// draft: replacing the browser device and issuing another company's/week's link.
test('draft survives a new device; company and week sessions remain isolated', async ({ browser, request }) => {
  const { default: Database } = await import('better-sqlite3');
  const path = await import('node:path');
  const root = process.env.SOCIAL_THEME_E2E_RUN_ROOT;
  expect(root, 'isolated fixture root required').toBeTruthy();
  const db = new Database(path.join(root!, 'social-theme.db'));
  db.prepare('INSERT OR IGNORE INTO clients (id, name, is_self) VALUES (?, ?, 0)').run('social-e2e-a', 'Fixture A');
  db.prepare('INSERT OR IGNORE INTO clients (id, name, is_self) VALUES (?, ?, 0)').run('social-e2e-b', 'Fixture B');
  db.close();
  const issue = async (company: string, week: string) => {
    const response = await request.post(`${OPERATOR_BASE}/api/social-theme/invitations`, {
      headers: { authorization: 'Bearer f27-e2e-operator-token' },
      data: { company_id: company, week_start_local: week, timezone: 'UTC' },
    });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const a1 = await issue('social-e2e-a', '2026-09-14');
  const a2 = await issue('social-e2e-a', '2026-09-21');
  const b1 = await issue('social-e2e-b', '2026-09-14');
  const first = await browser.newContext();
  const second = await browser.newContext();
  const other = await browser.newContext();
  try {
    const pageA = await first.newPage();
    await pageA.goto(a1.url);
    await pageA.getByTestId('enter-planner').click();
    await pageA.getByRole('button', { name: /Start this week|Resume where you left off/ }).click();
    await pageA.getByTestId('theme-input').fill('Private A saved draft');
    await expect(pageA.getByTestId('save-badge')).toHaveAttribute('data-state', 'saved');
    await pageA.close();
    // Operator renews the exact existing week. New browser has no old cookies.
    const renewed = await request.post(`${OPERATOR_BASE}/api/social-theme/renew`, {
      headers: { authorization: 'Bearer f27-e2e-operator-token' },
      data: { company_id: 'social-e2e-a', week_start_local: '2026-09-14' },
    });
    expect(renewed.status()).toBe(200);
    const pageResume = await second.newPage();
    await pageResume.goto((await renewed.json()).url);
    await pageResume.getByTestId('enter-planner').click();
    await pageResume.getByRole('button', { name: /Resume where you left off/ }).click();
    await expect(pageResume.getByTestId('theme-input')).toHaveValue('Private A saved draft');
    const own = await second.request.get(`${OPERATOR_BASE}/api/social-theme/session?company_id=social-e2e-b&session_id=${b1.session_id}`);
    expect(own.status()).toBe(200);
    expect((await own.json()).company_id).toBe('social-e2e-a');
    const pageB = await other.newPage();
    await pageB.goto(b1.url);
    await pageB.getByTestId('enter-planner').click();
    await pageB.getByRole('button', { name: /Start this week/ }).click();
    await expect(pageB.getByTestId('theme-input')).toHaveValue('');
    await pageB.goto(a2.url);
    await pageB.getByTestId('enter-planner').click();
    await pageB.getByRole('button', { name: /Start this week/ }).click();
    await expect(pageB.getByTestId('theme-input')).toHaveValue('');
    const week2 = await other.request.get(`${OPERATOR_BASE}/api/social-theme/session`);
    expect((await week2.json()).cycle.week_start_local).toBe('2026-09-21');
  } finally {
    await first.close(); await second.close(); await other.close();
  }
});
