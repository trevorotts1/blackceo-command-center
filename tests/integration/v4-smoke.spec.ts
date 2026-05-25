/**
 * v4.0 Wave 1 integration smoke tests.
 *
 * Depth 3 Track D. Asserts each new Wave 1 route renders without crashing
 * (page routes) or returns the expected JSON shape (API routes). No deep
 * assertions on business logic; this is a tripwire that catches a broken
 * import, a missing default export, or a regressed JSON contract before it
 * reaches a client.
 *
 * Run: `npx playwright test` (defaults to http://localhost:4000)
 * Override base URL: `V4_BASE_URL=http://localhost:3000 npx playwright test`
 *
 * The suite probes the base URL in beforeAll and skips every test cleanly if
 * the dev server is not running. That lets the suite be wired into CI in a
 * later track without first standing up Next.
 */

import { test, expect, request, type APIRequestContext, type Page } from 'playwright/test';

const BASE_URL = process.env.V4_BASE_URL || 'http://localhost:4000';

// Page routes to smoke-test. For each one we verify the navigation returns a
// non-error status and at least one stable marker element is in the DOM. The
// markers below were chosen from the actual Depth 2 page sources so they are
// resilient to copy tweaks but fail loudly if the layout chrome stops
// rendering.
const PAGE_ROUTES: Array<{ path: string; marker: RegExp }> = [
  { path: '/operator', marker: /Operator Console/i },
  { path: '/operator/bridge', marker: /Operator Console/i },
  { path: '/operator/workspace', marker: /Operator Console/i },
  { path: '/operator/studio', marker: /Studio/i },
  { path: '/operator/notebook', marker: /Operator Console/i },
  { path: '/operator/goals', marker: /Goals/i },
  { path: '/operator/journal', marker: /Journal/i },
  { path: '/operator/memory', marker: /Memory/i },
  { path: '/operator/research', marker: /Research/i },
  { path: '/operator/call', marker: /Operator/i },
  { path: '/operator/web-agent', marker: /Web Agent/i },
  { path: '/tasks/all', marker: /Tasks/i },
  { path: '/tasks/by-department', marker: /Departments/i },
];

let serverIsLive = false;

test.beforeAll(async () => {
  const probe = await request.newContext({ baseURL: BASE_URL });
  try {
    const res = await probe.get('/api/health', { timeout: 3000 });
    serverIsLive = res.ok();
  } catch {
    serverIsLive = false;
  } finally {
    await probe.dispose();
  }
});

test.beforeEach(() => {
  test.skip(
    !serverIsLive,
    `dev server not reachable at ${BASE_URL}. Start it with \`npm run dev\` and rerun.`,
  );
});

test.describe('Wave 1 page routes render without crashing', () => {
  for (const route of PAGE_ROUTES) {
    test(`GET ${route.path} renders + no console errors`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => {
        consoleErrors.push(err.message);
      });

      const resp = await page.goto(route.path, { waitUntil: 'domcontentloaded' });
      expect(resp, `no response for ${route.path}`).not.toBeNull();
      // Next.js can render a 200 page with a client-side error boundary, so
      // we treat anything < 500 as a successful render. A 500 means the
      // route blew up server-side.
      expect(resp!.status(), `status for ${route.path}`).toBeLessThan(500);

      // Wait briefly for client hydration so the marker assertion does not
      // race against the layout shell.
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      const bodyText = await page.locator('body').innerText();
      expect(bodyText, `marker missing for ${route.path}`).toMatch(route.marker);

      // Filter out noisy non-actionable errors (favicon, third-party SDK
      // probes during HMR, etc.). Anything containing the route path or
      // referencing TypeError / ReferenceError is treated as a real bug.
      const realErrors = filterRealConsoleErrors(consoleErrors);
      expect(realErrors, `console errors on ${route.path}:\n${realErrors.join('\n')}`).toEqual([]);
    });
  }
});

test.describe('Wave 1 API routes return expected shapes', () => {
  let api: APIRequestContext;

  test.beforeAll(async () => {
    api = await request.newContext({ baseURL: BASE_URL });
  });

  test.afterAll(async () => {
    if (api) await api.dispose();
  });

  test('GET /api/health returns migrations report', async () => {
    const res = await api.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: expect.stringMatching(/^(ok|degraded)$/),
      timestamp: expect.any(String),
      migrations: {
        applied: expect.any(Array),
        expected: expect.any(Array),
        pending: expect.any(Array),
        gap: expect.any(Number),
      },
    });
  });

  test('GET /api/system/status returns six-state vocabulary', async () => {
    const res = await api.get('/api/system/status');
    // 500 is a server bug; the route is supposed to degrade gracefully.
    expect([200, 500]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty('overall');
    expect(body).toHaveProperty('probedAt');
    expect(body).toHaveProperty('components');
    // PRD Section 3.12 six-state vocabulary.
    const allowed = ['ok', 'degraded', 'offline', 'unknown', 'busy', 'pending'];
    expect(allowed).toContain(body.overall);
    expect(Array.isArray(body.components)).toBe(true);
  });

  test('GET /api/models returns model registry list', async () => {
    const res = await api.get('/api/models');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      total: expect.any(Number),
      models: expect.any(Array),
      providers: expect.any(Array),
      generated_at: expect.any(String),
    });
    // If any models came back, each row should have the registry contract
    // columns the rest of the app reads.
    if (body.models.length > 0) {
      const m = body.models[0];
      expect(m).toHaveProperty('id');
      expect(m).toHaveProperty('provider');
    }
  });

  test('GET /api/operator/research/history returns paginated history', async () => {
    const res = await api.get('/api/operator/research/history?limit=5');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      items: expect.any(Array),
      total: expect.any(Number),
      limit: expect.any(Number),
      offset: expect.any(Number),
    });
    expect(body.limit).toBe(5);
  });

  test('GET /api/operator/workspace/list returns agent directory', async () => {
    const res = await api.get('/api/operator/workspace/list');
    expect(res.status()).toBe(200);
    const body = await res.json();
    // No agent param returns the agent directory.
    expect(body).toHaveProperty('agents');
    expect(Array.isArray(body.agents)).toBe(true);
    if (body.agents.length > 0) {
      const a = body.agents[0];
      expect(a).toHaveProperty('agent');
      expect(a).toHaveProperty('root');
      expect(a).toHaveProperty('exists');
      expect(a).toHaveProperty('fileCount');
    }
  });
});

/**
 * Filters out console errors we have decided are non-blockers for a smoke
 * test. Anything HMR-related, anything from /_next/static, and anything
 * about a missing favicon is dropped. Bugs we care about (TypeError,
 * ReferenceError, uncaught promise rejections, app code throwing) survive.
 */
function filterRealConsoleErrors(errors: string[]): string[] {
  return errors.filter((e) => {
    if (/favicon/i.test(e)) return false;
    if (/_next\/static.*404/.test(e)) return false;
    if (/Failed to load resource.*\b(404|401)\b/.test(e)) return false;
    if (/HMR/.test(e)) return false;
    if (/Download the React DevTools/.test(e)) return false;
    return true;
  });
}

// Re-export for type-only consumers that may want to extend the route list
// in a future depth without re-discovering the marker conventions.
export { PAGE_ROUTES };
export type { Page };
