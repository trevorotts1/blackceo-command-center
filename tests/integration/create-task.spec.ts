/**
 * P2-03 — CREATE-NEW-TASK WIRING, regression lock.
 *
 * Drives the REAL "New Task" flow end-to-end against a live Next server + a
 * real (isolated) SQLite DB — the exact reproduction the spec's part (c) step
 * 1 called for ("click New Task on the board, fill minimal fields, submit").
 *
 * FAIL-FIRST: against the pre-fix CreateTaskSchema (src/lib/validation.ts,
 * before P2-03 added `.nullable()` to assigned_agent_id/due_date), this test
 * fails — the create POST 400s ("Validation failed" on assigned_agent_id/
 * due_date being null), the save-error banner (also added by this fix)
 * renders, and no card appears in the Backlog column. With the fix applied,
 * it passes.
 *
 * Minimal fields on purpose: title only. Leaving the agent unassigned and the
 * due date empty is the DEFAULT state of a freshly-opened "New Task" form —
 * the most common real path, and exactly the one that was broken.
 */

import { test, expect, request } from 'playwright/test';
import { BASE_URL } from './create-task.fixture';

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
 * interviewComplete:true build-state and mints the signed cookie). Mirrors
 * the poll used in interview-lock.spec.ts's UNLOCK test — the setter is
 * fire-and-forget, so we reload an exempt page until the app itself confirms.
 */
async function unlockDashboard(page: import('playwright/test').Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const resp = await page.goto('/interview', { waitUntil: 'domcontentloaded' });
        void resp;
        // /tasks/all resolves 200 (not a 302 → /interview) once the cookie is set.
        const check = await page.request.get('/tasks/all', { maxRedirects: 0 });
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

test.describe('Create New Task — real UI, real API, real DB', () => {
  test('minimal create (title only, no agent, no due date) appears in Backlog', async ({
    page,
  }) => {
    await unlockDashboard(page);

    await page.goto('/tasks/all', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-walkthrough="column-backlog"]')).toBeVisible();

    // First-visit product walkthrough ("Kanban walkthrough · 1 of 6") renders
    // as a modal dialog that intercepts pointer events on the board below it.
    // Dismiss it before interacting with the board — a fresh fixture
    // DB/workspace always shows it on the first /tasks/all visit, and it
    // mounts client-side (after hydration), so wait for it explicitly rather
    // than a one-shot isVisible() check that can race the mount.
    const walkthroughSkip = page.getByRole('button', { name: 'Skip' });
    try {
      await walkthroughSkip.waitFor({ state: 'visible', timeout: 5_000 });
      await walkthroughSkip.click();
      await walkthroughSkip.waitFor({ state: 'hidden', timeout: 5_000 });
    } catch {
      // Walkthrough didn't appear (e.g. already dismissed by a prior run
      // sharing the fixture) — nothing to dismiss.
    }

    const title = `E2E create-task ${Date.now()}`;

    // Open the header-level "New Task" modal (not a column '+', so status
    // defaults to backlog — the create-form's own default).
    await page.locator('[data-walkthrough="new-task"]').click();
    await expect(page.getByRole('heading', { name: 'Create New Task' })).toBeVisible();

    // MINIMAL fields: title only. Agent stays "Unassigned", due date stays
    // empty — the default state, and the exact payload shape that 400'd
    // pre-fix (assigned_agent_id:null, due_date:null).
    await page.getByPlaceholder('What needs to be done?').fill(title);

    await page.getByRole('button', { name: /^Save$/ }).click();

    // The generic save-error banner (added by this fix) must NOT appear —
    // pre-fix this assertion is what actually catches the regression: the
    // banner renders with the Zod validation message instead of the modal
    // closing.
    await expect(page.locator('[data-testid="task-save-error"]')).toHaveCount(0, {
      timeout: 5_000,
    });

    // Modal closes on a successful create.
    await expect(page.getByRole('heading', { name: 'Create New Task' })).toHaveCount(0, {
      timeout: 5_000,
    });

    // The new card is visible INSIDE the Backlog column with the exact title.
    // Generous timeout: on a cold `next dev` compile (this suite always spawns
    // a fresh server), the FIRST hit of a route can add real latency on top of
    // the in-process routing / persona-pin work createTaskCore awaits before
    // POST /api/tasks resolves.
    const backlogColumn = page.locator('[data-walkthrough="column-backlog"]');
    await expect(backlogColumn.getByText(title, { exact: true })).toBeVisible({ timeout: 20_000 });

    // Independently confirm via the real API (not just the client store) that
    // the task actually persisted with status backlog and the null fields
    // came through as null, not silently dropped or coerced.
    //
    // Uses page.evaluate (a real in-page `fetch`, sending the Origin header a
    // browser always attaches) rather than page.request — the latter is
    // Playwright's own HTTP client and does NOT send Origin/Referer, so it is
    // correctly rejected as an "external" caller by the same-origin gate
    // (src/middleware.ts's isSameOriginRequest) on a box with no MC_API_TOKEN,
    // which is the fixture's (and a fresh dev box's) default posture.
    const tasks = await page.evaluate(async () => {
      const res = await fetch('/api/tasks?status=backlog');
      if (!res.ok) throw new Error(`GET /api/tasks?status=backlog -> ${res.status}`);
      return (await res.json()) as Array<{
        title: string;
        status: string;
        assigned_agent_id: string | null;
        due_date: string | null;
      }>;
    });
    const created = tasks.find((t) => t.title === title);
    expect(created, 'the created task must be retrievable from GET /api/tasks').toBeTruthy();
    expect(created?.status).toBe('backlog');
    expect(created?.assigned_agent_id).toBeNull();
    expect(created?.due_date).toBeNull();
  });
});
