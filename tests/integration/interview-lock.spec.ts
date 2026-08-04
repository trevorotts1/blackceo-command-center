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
 * STANDARD-FIRST ADDITION (AI Workforce standard-first redesign, PHASE 6b):
 *   4. STANDARD_READY ≠ UNLOCK — the NEW third state "standard prebuild done +
 *      interview INCOMPLETE" (build-state standardPrebuild.status="done",
 *      interviewComplete absent) must leave the shell-lock EXACTLY as locked as
 *      the bare-incomplete state: every non-exempt page still 302s to
 *      /interview; only the exemptions stay open — /interview, /onboarding/*,
 *      and the new READ-ONLY /preview company view (Option L1: the lock gains a
 *      read-only preview exemption, it is NEVER loosened). gate-status reports
 *      standardReady=true alongside interviewComplete=false, and /preview
 *      renders the fixture's chosen-departments artifact with zero mutation
 *      affordances.
 *
 * DETERMINISM + SAFETY: state is seeded into a throwaway fixture workspace under
 * test-results/ (interview-lock.fixture.ts), pointed at by the server's
 * OPENCLAW_WORKSPACE_ROOT — never the operator's canonical files, never
 * ~/.openclaw. The signed cookie is only ever MINTED by the app's own setter and
 * VERIFIED by the app's own middleware; this spec only observes it (read-only) —
 * it never forges a token, so no gate is weakened.
 */

import { test, expect, request, type APIRequestContext } from 'playwright/test';
import {
  BASE_URL,
  INTERVIEW_COOKIE_NAME,
  LATCH_COOKIE_NAME,
  STANDARD_READY_DEPTS,
  writeBuildState,
  writeStandardPrebuildState,
  writeDepartmentsJson,
  forgeCompleteCookie,
  forgeExpiredCompleteCookie,
  forgeForgedCookie,
} from './interview-lock.fixture';

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

    // /preview — the standard-first READ-ONLY company view (Option L1). While the
    // interview lock holds it must never 302 to /interview (the day-one link
    // surface) and must never 500 — when no company build exists yet it renders
    // its "not ready" placeholder.
    const preview = await page.request.get('/preview', { maxRedirects: 0 });
    expect(
      isRedirectToInterview(preview.status(), preview.headers()['location']),
      '/preview must be exempt from the interview lock (standard-first day-one surface)',
    ).toBeFalsy();
    expect(preview.status(), '/preview must not server-error').toBeLessThan(500);

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

test.describe('Interview-mode shell lock — U010 fallback + latch', () => {
  test.beforeAll(() => writeBuildState(false));

  test('U010-A: absent cookie + complete build-state → admitted (fallback path)', async ({
    page,
    context,
  }) => {
    // Prime the build-state as complete but clear ALL gate cookies so the
    // middleware must fall back to /api/interview/gate-status.
    writeBuildState(true);
    await context.clearCookies();

    // Navigating to a gated page should resolve 200 (not 302 → /interview)
    // because the middleware's fallback fetch sees build-state says complete.
    const resp = await page.request.get('/operator', { maxRedirects: 0 });
    expect(resp.status(), 'fallback path must admit when build-state is complete').toBe(200);
  });

  test('U010-B: latch-only cookie → admitted', async ({ page, context }) => {
    // Place ONLY a valid latch cookie (no main mc_interview_complete cookie).
    // The middleware checks the main cookie first (absent → fail), then the
    // latch (valid-complete → admit).
    writeBuildState(false);
    await context.clearCookies();
    await context.addCookies([
      {
        name: LATCH_COOKIE_NAME,
        value: forgeCompleteCookie(),
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    const resp = await page.request.get('/operator', { maxRedirects: 0 });
    expect(resp.status(), 'latch-only cookie must admit').toBe(200);
  });

  test('U010-C: forged cookie → 302', async ({ page, context }) => {
    // A cookie claiming complete=true but signed with the wrong HMAC must be
    // rejected — the middleware fails CLOSED to /interview.
    writeBuildState(false);
    await context.clearCookies();
    await context.addCookies([
      {
        name: INTERVIEW_COOKIE_NAME,
        value: forgeForgedCookie(),
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    const resp = await page.request.get('/operator', { maxRedirects: 0 });
    const location = resp.headers()['location'];
    expect(
      isRedirectToInterview(resp.status(), location),
      `forged cookie must 302 to /interview (got ${resp.status()} → ${location ?? 'no Location'})`,
    ).toBeTruthy();
  });

  test('U010-D: expired-complete cookie → 200 (monotonic unlock)', async ({ page, context }) => {
    // An expired-but-signature-valid "complete" cookie must still admit because
    // completion is terminal — the middleware accepts it and the setter re-mints
    // a fresh one on the next page load.
    writeBuildState(false);
    await context.clearCookies();
    await context.addCookies([
      {
        name: INTERVIEW_COOKIE_NAME,
        value: forgeExpiredCompleteCookie(),
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    const resp = await page.request.get('/operator', { maxRedirects: 0 });
    expect(resp.status(), 'expired-complete cookie must still admit (completion is terminal)').toBe(
      200,
    );
  });

  test('U010-E: gate-status returns the two booleans', async ({ page }) => {
    // The /api/interview/gate-status endpoint (internal fallback target) must
    // return the two canonical completion signals as JSON booleans.
    // When locked (incomplete): both should be false.
    writeBuildState(false);
    let resp = await page.request.get('/api/interview/gate-status', { maxRedirects: 0 });
    expect(resp.status(), 'gate-status must return 200').toBe(200);
    let body = await resp.json();
    expect(body, 'gate-status must return object').toEqual(
      expect.objectContaining({
        interviewComplete: false,
        buildCompleted: false,
      }),
    );

    // When complete: interviewComplete must be true.
    writeBuildState(true);
    resp = await page.request.get('/api/interview/gate-status', { maxRedirects: 0 });
    expect(resp.status()).toBe(200);
    body = await resp.json();
    expect(body).toEqual(
      expect.objectContaining({
        interviewComplete: true,
        buildCompleted: false,
      }),
    );
  });

  test.beforeEach(() => writeBuildState(false));
  test.afterEach(() => writeBuildState(false));
});

test.describe('Interview-mode shell lock — standard-first (standardReady + incomplete = still LOCKED)', () => {
  // The standard-first third state: the prebuild driver finished (chosen
  // artifact written, board seeded) but the owner has NOT completed the
  // interview. The ratified shell-lock doctrine says the dashboard stays the
  // closeout reveal — a standardPrebuild block must NEVER unlock the shell.
  test.beforeAll(() => writeDepartmentsJson());
  test.beforeEach(() => {
    writeDepartmentsJson();
    writeStandardPrebuildState(false);
  });
  test.afterEach(() => writeBuildState(false)); // restore the locked baseline

  test('SF-1: standardReady=true + interviewComplete=false → every non-exempt page still 302s to /interview', async ({
    page,
    context,
  }) => {
    // No completion cookie can exist in this state; clear any leftover so the
    // middleware runs its full fail-closed chain.
    await context.clearCookies();

    for (const path of GATED_PAGES) {
      const resp = await page.request.get(path, { maxRedirects: 0 });
      const status = resp.status();
      const location = resp.headers()['location'];
      expect(
        isRedirectToInterview(status, location),
        `standard-prebuilt box: ${path} must still redirect to /interview (got ${status} → ${location ?? 'no Location'})`,
      ).toBeTruthy();
    }
  });

  test('SF-2: standardReady=true → only /interview, /onboarding/*, and /preview stay reachable', async ({
    page,
    context,
  }) => {
    await context.clearCookies();

    // /interview renders.
    const interview = await page.request.get('/interview', { maxRedirects: 0 });
    expect(interview.status(), '/interview must render on a standard-prebuilt box').toBe(200);

    // /onboarding/* stays exempt.
    const onboarding = await page.request.get('/onboarding/building', { maxRedirects: 0 });
    expect(
      isRedirectToInterview(onboarding.status(), onboarding.headers()['location']),
      '/onboarding/* must stay exempt on a standard-prebuilt box',
    ).toBeFalsy();
    expect(onboarding.status()).toBeLessThan(500);

    // /preview — the new read-only company view — resolves and renders the
    // fixture's chosen-departments artifact.
    const preview = await page.request.get('/preview', { maxRedirects: 0 });
    expect(
      isRedirectToInterview(preview.status(), preview.headers()['location']),
      '/preview must be exempt while a standard-prebuilt box is locked',
    ).toBeFalsy();
    expect(preview.status(), '/preview must resolve 200 once the standard set is ready').toBe(200);
    const html = await preview.text();
    for (const dept of STANDARD_READY_DEPTS) {
      expect(
        html,
        `/preview must list the fixture department ${dept.id}`,
      ).toContain(dept.id);
    }
  });

  test('SF-3: gate-status reports standardReady=true alongside interviewComplete=false', async ({
    page,
  }) => {
    const resp = await page.request.get('/api/interview/gate-status', { maxRedirects: 0 });
    expect(resp.status(), 'gate-status must return 200').toBe(200);
    const body = await resp.json();
    expect(body, 'standard-prebuilt + incomplete gate-status').toEqual(
      expect.objectContaining({
        interviewComplete: false,
        buildCompleted: false,
        standardReady: true,
      }),
    );

    // The legacy bare-incomplete state still reports standardReady=false — a box
    // that never prebuilt is NOT standard-ready.
    writeBuildState(false);
    const legacy = await page.request.get('/api/interview/gate-status', { maxRedirects: 0 });
    expect(legacy.status()).toBe(200);
    expect(await legacy.json()).toEqual(
      expect.objectContaining({
        interviewComplete: false,
        buildCompleted: false,
        standardReady: false,
      }),
    );

    // Completion flips interviewComplete WITHOUT flipping standardReady off.
    writeStandardPrebuildState(true);
    const done = await page.request.get('/api/interview/gate-status', { maxRedirects: 0 });
    expect(done.status()).toBe(200);
    expect(await done.json()).toEqual(
      expect.objectContaining({
        interviewComplete: true,
        standardReady: true,
      }),
    );
  });

  test('SF-4: /preview stays reachable AFTER interview completion (the exempt surface survives unlock)', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    writeStandardPrebuildState(true);

    const resp = await page.request.get('/preview', { maxRedirects: 0 });
    expect(resp.status(), '/preview must resolve 200 after completion').toBe(200);
    expect(
      isRedirectToInterview(resp.status(), resp.headers()['location']),
      '/preview must never be swallowed by the lock redirect',
    ).toBeFalsy();
  });

  test('SF-5: the /preview surface is READ-ONLY — zero mutation affordances in the rendered HTML', async ({
    page,
  }) => {
    await page.goto('/preview', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    expect(new URL(page.url()).pathname, 'must land on /preview, not /interview').toBe('/preview');

    // The preview PAGE itself ships NO forms, NO buttons, NO links — it is a
    // pure server-rendered read of departments.json + workspaces rows (Option
    // L1's read-only guarantee: no mutation route reachable from this surface).
    // Scoped to <main>: the app-wide root-layout chrome (walkthrough helper
    // etc.) is shared infrastructure every page renders and is NOT part of the
    // preview surface's affordances.
    expect(await page.locator('main form').count(), '/preview page must render zero forms').toBe(0);
    expect(await page.locator('main button').count(), '/preview page must render zero buttons').toBe(0);
    expect(await page.locator('main a').count(), '/preview page must render zero links').toBe(0);

    // The fixture's departments render in the browser (not just in the raw
    // server response), proving the chosen artifact drove the view.
    const bodyText = await page.locator('body').innerText();
    for (const dept of STANDARD_READY_DEPTS) {
      expect(bodyText, `/preview must render ${dept.id} in the browser`).toContain(dept.id);
    }
  });
});

// Re-export for a future depth that wants to extend the gated-route list without
// re-discovering the redirect conventions.
export { GATED_PAGES };
export type { APIRequestContext };
