/**
 * Interview-mode shell-lock E2E (WG-6 / WG-10c — command-center half).
 *
 * Proves the P0-5 / WG-9 lock end-to-end against the REAL Edge middleware
 * (src/middleware.ts) and the sanctioned Node cookie-setter (refreshInterviewGate
 * → signInterviewToken), driven through a live Next server this suite stands up
 * (see playwright.interview-lock.config.ts):
 *
 *   1. LOCK HOLDS  — while the interview is INCOMPLETE, any non-exempt page GET is
 *      302-redirected to /interview. No valid completion cookie can exist, so the
 *      middleware fails CLOSED.
 *   2. EXEMPT OPEN — /interview, /onboarding/*, and /api/* stay reachable (never
 *      redirected to /interview) even while locked.
 *   3. UNLOCK      — after interview completion is signalled the SANCTIONED way
 *      (interviewComplete in the fixture build-state → the client shim's
 *      refreshInterviewGate mints the signed `mc_interview_complete` cookie), the
 *      dashboard unlocks: /operator resolves 200 and renders.
 *
 * DETERMINISM + SAFETY: state is seeded into a throwaway fixture workspace under
 * test-results/ (interview-lock.fixture.ts), pointed at by the server's
 * OPENCLAW_WORKSPACE_ROOT — never the operator's canonical files, never
 * ~/.openclaw. The signed cookie is only ever MINTED by the app's own setter and
 * VERIFIED by the app's own middleware; this spec only observes it (read-only) —
 * it never forges a token, so no gate is weakened.
 */

import { test, expect, request, type APIRequestContext } from 'playwright/test';
import { BASE_URL, INTERVIEW_COOKIE_NAME, writeBuildState } from './interview-lock.fixture';

/** Non-exempt page routes that MUST be locked to /interview while incomplete. */
const GATED_PAGES = ['/', '/operator', '/tasks/all'];

/** A 3xx whose Location targets /interview (the lock redirect). */
function isRedirectToInterview(status: number, location: string | undefined): boolean {
  return (
    status >= 300 &&
    status < 400 &&
    !!location &&
    /\/interview(?:$|[/?#])/.test(location)
  );
}

/**
 * READ-ONLY decode of the signed gate cookie's `complete` bit. We never sign or
 * forge — the server's sanctioned setter mints the token; here we only confirm
 * the app flipped it to "complete". Mirrors the base64url payload layout in
 * src/lib/interview/gate-cookie.ts (payloadB64.signature).
 */
function cookieSaysComplete(value: string | undefined): boolean {
  if (!value) return false;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return false;
  try {
    const b64 = value.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, 'base64').toString('utf-8');
    return (JSON.parse(json) as { complete?: unknown }).complete === true;
  } catch {
    return false;
  }
}

// Fail LOUDLY (not skip) if the server the config stood up is unreachable — this
// suite is meant to actually execute the lock in CI, never silently no-op.
test.beforeAll(async () => {
  const probe = await request.newContext({ baseURL: BASE_URL });
  try {
    const res = await probe.get('/api/health', { timeout: 10_000 });
    expect(res.ok(), `dev server not reachable at ${BASE_URL}/api/health`).toBeTruthy();
  } finally {
    await probe.dispose();
  }
});

test.describe.configure({ mode: 'serial' });

test.describe('Interview-mode shell lock (WG-9)', () => {
  // Keep the fixture in the LOCKED state for the lock/exempt tests. The unlock
  // test flips it and restores it in an afterEach below.
  test.beforeAll(() => writeBuildState(false));

  test('LOCK: every non-exempt page is 302-redirected to /interview while incomplete', async ({
    page,
  }) => {
    for (const path of GATED_PAGES) {
      const resp = await page.request.get(path, { maxRedirects: 0 });
      const status = resp.status();
      const location = resp.headers()['location'];
      expect(
        isRedirectToInterview(status, location),
        `expected ${path} to redirect to /interview (got ${status} → ${location ?? 'no Location'})`,
      ).toBeTruthy();
    }
  });

  test('LOCK holds even after a page load warms the (incomplete) cookie', async ({
    page,
    context,
  }) => {
    // Visiting the exempt /interview fires the client shim (refreshInterviewGate),
    // which — with the fixture still incomplete — mints an INCOMPLETE cookie.
    await page.goto('/interview', { waitUntil: 'networkidle' });

    // The cookie may now exist, but it must NOT read as complete...
    const cookie = (await context.cookies()).find((c) => c.name === INTERVIEW_COOKIE_NAME);
    expect(cookieSaysComplete(cookie?.value)).toBeFalsy();

    // ...and the dashboard is still locked.
    const resp = await page.request.get('/operator', { maxRedirects: 0 });
    expect(
      isRedirectToInterview(resp.status(), resp.headers()['location']),
      'dashboard must stay locked while the interview is incomplete',
    ).toBeTruthy();
  });

  test('EXEMPT: /interview, /onboarding/*, and /api/* stay reachable while locked', async ({
    page,
  }) => {
    // /interview — the lock target itself renders (no redirect loop).
    const interview = await page.request.get('/interview', { maxRedirects: 0 });
    expect(interview.status(), '/interview must render').toBe(200);

    // /onboarding/* — exempt; must NOT be redirected to /interview by the lock.
    const onboarding = await page.request.get('/onboarding/building', { maxRedirects: 0 });
    expect(
      isRedirectToInterview(onboarding.status(), onboarding.headers()['location']),
      '/onboarding/* must be exempt from the interview lock',
    ).toBeFalsy();
    expect(onboarding.status(), '/onboarding/building must not server-error').toBeLessThan(500);

    // /api/* — never interview-locked. /api/health is the documented bypass.
    const health = await page.request.get('/api/health', { maxRedirects: 0 });
    expect(health.status(), '/api/health must be reachable').toBe(200);

    // A non-bypass API route is likewise never redirected to /interview (its own
    // auth may 401/503 without a token, but the interview lock must not touch it).
    const api = await page.request.get('/api/models', { maxRedirects: 0 });
    expect(
      isRedirectToInterview(api.status(), api.headers()['location']),
      '/api/* must be exempt from the interview lock',
    ).toBeFalsy();
  });

  test('UNLOCK: signalling completion (sanctioned path) unlocks the dashboard', async ({
    page,
    context,
  }) => {
    // 1) Signal completion the sanctioned way: set interviewComplete in the
    //    fixture build-state. refreshInterviewGate derives completion from this
    //    exact field (never a hand-forged cookie).
    writeBuildState(true);

    // 2) Fire the sanctioned setter by loading an exempt page that mounts the
    //    root layout's InterviewGateSync shim, and poll until the app itself has
    //    minted a signature-valid "complete" cookie. The server action is
    //    fire-and-forget, so we reload to re-fire until the cookie flips.
    await expect
      .poll(
        async () => {
          await page.goto('/interview', { waitUntil: 'networkidle' });
          const cookie = (await context.cookies()).find(
            (c) => c.name === INTERVIEW_COOKIE_NAME,
          );
          return cookieSaysComplete(cookie?.value);
        },
        {
          timeout: 30_000,
          intervals: [500, 1_000, 2_000, 3_000],
          message: 'app never minted a complete gate cookie after completion was signalled',
        },
      )
      .toBeTruthy();

    // 3) Edge check: /operator now resolves without a redirect to /interview.
    const resp = await page.request.get('/operator', { maxRedirects: 0 });
    expect(
      isRedirectToInterview(resp.status(), resp.headers()['location']),
      `dashboard should be unlocked (got ${resp.status()} → ${resp.headers()['location'] ?? 'no Location'})`,
    ).toBeFalsy();
    expect(resp.status(), '/operator should resolve 200 once unlocked').toBe(200);

    // 4) Browser check: the operator console actually renders (no client redirect).
    await page.goto('/operator', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    expect(new URL(page.url()).pathname, 'must land on /operator, not /interview').toBe(
      '/operator',
    );
    const bodyText = await page.locator('body').innerText();
    expect(bodyText, 'Operator Console must render once unlocked').toMatch(/Operator Console/i);
  });

  // Restore the locked default so a rerun (or a shared server via
  // reuseExistingServer) starts from the same incomplete baseline.
  test.afterEach(() => writeBuildState(false));
});

// Re-export for a future depth that wants to extend the gated-route list without
// re-discovering the redirect conventions.
export { GATED_PAGES };
export type { APIRequestContext };
