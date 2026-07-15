/**
 * U43 (C/C-12) — Home-dashboard "missing cards", induced-failure proof.
 *
 * P1-03 (`src/lib/dashboard-workspaces.ts` + `src/app/page.tsx`) is already
 * VERIFIED shipped in-repo, with its own pure-logic unit-test suite
 * (`tests/unit/p1-03-dashboard-workspaces.test.ts`). What NO existing suite
 * covers is the actual DOM/render behavior on a live page: this spec drives
 * the REAL home page against a REAL Next dev server and INDUCES the failure
 * the spec's part (a) calls for — "kill `/api/workspaces` (temporary
 * middleware fault injection or stopped route) and observe the DEGRADED
 * placeholder card render with the retry copy — then restore and observe
 * recovery within 15s; confirm the `dashboard_workspaces_fetch_failed` event
 * row lands."
 *
 * FAULT MECHANISM: client-side Playwright network-route interception
 * (`page.route('**\/api/workspaces', ...)`) that aborts the request —
 * observably identical, from the page's point of view, to the route being
 * "stopped" (a real `fetch()` failure the page's own catch block must
 * handle). This makes ZERO production-code or server-config changes —
 * BINARY acceptance (c): "zero client-box changes performed by this unit
 * (audit only; fixes ride the next batched roll)." The fault is lifted by
 * flipping an in-test flag (not by reloading the page), so the RECOVERY half
 * of the proof exercises the page's own already-scheduled automatic retry
 * loop (`WORKSPACES_RETRY_MS`), not a fresh page load.
 *
 * FAIL-FIRST PROOF: run against the pre-P1-03 tree (before `page.tsx` tracked
 * `workspacesStatus` and rendered the degraded slot), the first assertion
 * below — `[data-testid="producer-boards-degraded"]` becoming visible — times
 * out and fails, because a failed fetch used to leave `presentSlugs` empty
 * with NO degraded indicator at all (the fail-EMPTY bug P1-03 fixed).
 */

import { test, expect, request, type Page } from 'playwright/test';
import { BASE_URL } from './home-dashboard-fault.fixture';
import { WORKSPACES_RETRY_MS } from '../../src/lib/dashboard-workspaces';

test.beforeAll(async () => {
  const probe = await request.newContext({ baseURL: BASE_URL });
  try {
    const res = await probe.get('/api/health', { timeout: 10_000 });
    expect(res.ok(), `dev server not reachable at ${BASE_URL}/api/health`).toBeTruthy();
  } finally {
    await probe.dispose();
  }
});

/**
 * Fire the sanctioned interview-gate cookie setter (root layout's
 * InterviewGateSync shim reads the fixture's pre-seeded
 * interviewComplete:true build-state and mints the signed cookie) — mirrors
 * create-task.spec.ts's / agent-navigation.spec.ts's `unlockDashboard`. The
 * home page ('/') is NOT on the interview-lock exempt list
 * (`src/middleware.ts`'s `isInterviewGateExempt`), so it 302s to /interview
 * until this cookie is minted.
 */
async function unlockDashboard(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto('/interview', { waitUntil: 'domcontentloaded' });
        const check = await page.request.get('/', { maxRedirects: 0 });
        return check.status();
      },
      {
        timeout: 30_000,
        intervals: [500, 1_000, 2_000, 3_000],
        message: 'dashboard never unlocked (interview gate cookie was never minted complete)',
      },
    )
    .toBe(200);
}

test.describe('Home dashboard — induced /api/workspaces failure (U43 / C-12)', () => {
  test('failed /api/workspaces renders the degraded placeholder + retry copy, logs the event, then recovers within the retry window', async ({
    page,
  }) => {
    let faultActive = true;
    let capturedEventBody: { type?: string; metadata?: { attempt?: number; reason?: string } } | null =
      null;

    // Fault injection: abort every /api/workspaces request while faultActive
    // is true — a real fetch() failure, indistinguishable to the page from a
    // stopped route. Flipping faultActive (below) lifts the fault WITHOUT a
    // page reload, so recovery exercises the page's own scheduled retry.
    await page.route('**/api/workspaces', async (route) => {
      if (faultActive) {
        await route.abort('failed');
      } else {
        await route.continue();
      }
    });

    // Observe (never block) the durable failure record P1-03 fires via
    // POST /api/events — capture the first dashboard_workspaces_fetch_failed
    // body without interfering with the app's own fire-and-forget POST.
    await page.route('**/api/events', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        try {
          const body = req.postDataJSON();
          if (body?.type === 'dashboard_workspaces_fetch_failed' && !capturedEventBody) {
            capturedEventBody = body;
          }
        } catch {
          // non-JSON body — ignore, still let the real request through below.
        }
      }
      await route.continue();
    });

    await unlockDashboard(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // ── INDUCED-FAILURE ASSERTION ────────────────────────────────────────
    const degradedSlot = page.locator('[data-testid="producer-boards-degraded"]');
    await expect(degradedSlot, 'degraded placeholder must render on a failed /api/workspaces fetch — never silent omission (the pre-P1-03 fail-EMPTY bug)').toBeVisible({
      timeout: 15_000,
    });
    await expect(degradedSlot.getByText('Board data unavailable — retrying')).toBeVisible();
    await expect(degradedSlot.getByText(new RegExp(`retrying automatically every ${WORKSPACES_RETRY_MS / 1000} seconds`, 'i'))).toBeVisible();

    await page.screenshot({
      path: 'test-results/home-dashboard-fault/induced-failure.png',
      fullPage: true,
    });

    // ── FETCH-FAILED EVENT ASSERTION ─────────────────────────────────────
    await expect
      .poll(() => capturedEventBody?.type, {
        timeout: 10_000,
        message: 'dashboard_workspaces_fetch_failed event never observed on POST /api/events',
      })
      .toBe('dashboard_workspaces_fetch_failed');
    expect(capturedEventBody?.metadata?.attempt).toBe(1);
    expect(typeof capturedEventBody?.metadata?.reason).toBe('string');
    expect((capturedEventBody?.metadata?.reason ?? '').length).toBeGreaterThan(0);

    // ── LIFT THE FAULT, OBSERVE RECOVERY WITHIN THE RETRY WINDOW ─────────
    // The page already scheduled its own retry for WORKSPACES_RETRY_MS after
    // the first failure (src/app/page.tsx's loadWorkspaceSlugs retry timer).
    // We only flip the flag — no reload — so the assertion below proves the
    // SAME in-page retry loop recovers, not a fresh page load succeeding.
    faultActive = false;

    const recoveredResponse = await page.waitForResponse(
      (resp) => resp.url().includes('/api/workspaces') && resp.request().method() === 'GET',
      { timeout: WORKSPACES_RETRY_MS + 10_000 },
    );
    expect(recoveredResponse.ok(), 'the recovered /api/workspaces retry must succeed (200)').toBeTruthy();

    // Degraded slot must disappear once the retry succeeds — the page
    // returns to its normal (non-degraded) card layout. This fixture seeds
    // no producer workspace, so "producer cards after recovery" is correctly
    // ZERO producer cards (a box with no producer engines) — the exact
    // behavior selectProducerCardSlugs's own contract calls "correct, not a
    // degraded placeholder" (see src/lib/dashboard-workspaces.ts).
    await expect(degradedSlot, 'degraded slot must clear once /api/workspaces recovers').toHaveCount(0, {
      timeout: 5_000,
    });

    // The rest of the always-present entry-card grid must be intact and
    // navigable post-recovery — the page never got stuck in a partial/broken
    // render while the fault was active.
    await expect(page.getByRole('heading', { name: 'View All Tasks' })).toBeVisible();

    await page.screenshot({
      path: 'test-results/home-dashboard-fault/recovered.png',
      fullPage: true,
    });
  });
});
