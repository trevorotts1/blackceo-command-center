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
 *
 * U41 (C/C-10) extends this file with the two coverage holes the master spec
 * names explicitly: a workspace-scoped department-board create (part b) and
 * an SSE-broadcast + instant-routing/persona-pin-kickoff proof (part c). See
 * the second `test.describe` block below.
 */

import { test, expect, request, type Page } from 'playwright/test';
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
async function unlockDashboard(page: Page): Promise<void> {
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

/**
 * The first-visit product walkthrough ("Kanban walkthrough · 1 of 6") renders
 * as a modal dialog that intercepts pointer events on the board below it.
 * Dismiss it before interacting with the board — a fresh fixture DB/workspace
 * always shows it on the first board visit, and it mounts client-side (after
 * hydration), so wait for it explicitly rather than a one-shot isVisible()
 * check that can race the mount. Shared by every test in this file that opens
 * a board page for the first time.
 */
async function dismissWalkthroughIfPresent(page: Page): Promise<void> {
  const walkthroughSkip = page.getByRole('button', { name: 'Skip' });
  try {
    await walkthroughSkip.waitFor({ state: 'visible', timeout: 5_000 });
    await walkthroughSkip.click();
    await walkthroughSkip.waitFor({ state: 'hidden', timeout: 5_000 });
  } catch {
    // Walkthrough didn't appear (e.g. already dismissed by a prior run
    // sharing the fixture) — nothing to dismiss.
  }
}

test.describe('Create New Task — real UI, real API, real DB', () => {
  test('minimal create (title only, no agent, no due date) appears in Backlog', async ({
    page,
  }) => {
    await unlockDashboard(page);

    await page.goto('/tasks/all', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-walkthrough="column-backlog"]')).toBeVisible();

    await dismissWalkthroughIfPresent(page);

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

/**
 * U41 (C/C-10) part (b) + part (c) — the two coverage holes the master spec
 * calls out by name, on top of the P2-03 regression lock above:
 *
 *  (b) Workspace-scoped board create: the P2-03 narrative names TaskModal-on-
 *      `/tasks/all` hardcoding `workspace_id:'default'` (tasks.ts, the
 *      "phantom workspace" comment block). This asserts the OTHER path — a
 *      create from a real department workspace page — stamps the page's real
 *      `workspace_id` (never NULL, never 'default') AND that the department
 *      backfill (tasks.ts, "Department backfill (UI-created-task visibility
 *      fix)") lands the canonical department slug, so the card is visible
 *      under its own department-scoped board (the workspace page IS the
 *      department filter — MissionQueue locks `selectedDepartment` to the
 *      route, `workspace/[slug]/page.tsx`).
 *
 *  (c) SSE + instant-routing + persona-pin proof: rather than re-assert the
 *      ambiguous "card shows up after I just submitted its own form" (which
 *      TaskModal already satisfies via its OWN optimistic `addTask()` on a
 *      200, independent of the broadcast), this test creates the task via a
 *      SECOND, independent API context while an already-open, already-idle
 *      board page sits there with nothing of its own to optimistically add.
 *      The only way that page's Backlog column can show the new card is the
 *      `task_created` SSE broadcast (tasks.ts) → `useSSE.ts`'s `case
 *      'task_created': addTask(...)`. This is a genuine, unambiguous proof of
 *      the live-update path, not a coincidence of two code paths converging.
 *      The same create also proves instant routing kicked off (a seeded
 *      master agent guarantees the CEO/COM last-resort routing step assigns
 *      it, firing the `task_dispatched` "Auto-routed:" event) and that
 *      persona-pin resolution is kicked off CONCURRENTLY rather than
 *      blocking the create response (the POST returns fast; persona
 *      resolution — a background python3 invocation this sandboxed fixture
 *      has no OPENCLAW_ROOT for — fails safely and non-fatally afterward,
 *      exactly as designed).
 *
 * Every seed/readback/create call in this block goes through the PAGE's own
 * in-browser `fetch` (a real Origin header) via `pageFetchJson()` below,
 * never a detached Playwright APIRequestContext. The middleware's
 * same-origin gate (src/middleware.ts, `isSameOriginRequest`) 503s any
 * /api/* call it can't prove is same-origin when MC_API_TOKEN is unset —
 * this fixture's (and a fresh dev box's) default posture — exactly the
 * distinction the first test in this file already documents for its own GET
 * readback. `page.evaluate` runs in-page, so it always qualifies; the create
 * in part (c) still proves the SSE path because it never goes through
 * TaskModal's own `handleSubmit`/`addTask()` — a raw in-page `fetch()` call
 * has no path to the Zustand store except the SSE listener.
 */
async function pageFetchJson<T>(
  page: Page,
  input: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; body: T }> {
  return page.evaluate(
    async ({ input, init }) => {
      const res = await fetch(input, {
        method: init?.method ?? 'GET',
        headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
      const body = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body };
    },
    { input, init },
  );
}

test.describe('Create New Task — workspace-scoped board + SSE/routing proof (C-10 parts b/c)', () => {
  test('department-workspace create stamps real workspace_id + department; a second, independent create is picked up live via SSE with routing + persona-pin kicked off', async ({
    page,
  }) => {
    // A same-origin page must be loaded before any pageFetchJson() call below
    // (relative fetch() needs a document to resolve against, and the gate
    // needs the real Origin header a loaded page sends).
    await unlockDashboard(page);

    // ---- Create a real department workspace (the "Add Department" path) ----
    const wsName = `E2E Dept ${Date.now()}`;
    const wsRes = await pageFetchJson<{ id: string; slug: string; name: string }>(page, '/api/workspaces', {
      method: 'POST',
      body: { name: wsName },
    });
    expect(wsRes.ok, `POST /api/workspaces -> ${wsRes.status}`).toBeTruthy();
    const workspace = wsRes.body;
    expect(workspace.id).toBeTruthy();
    expect(workspace.slug).toBeTruthy();

    // ---- Seed a routing fallback --------------------------------------------
    // Step 4 of comDispatch() (src/lib/routing/department-router.ts) is the
    // CEO/COM "no department match" last resort: ANY is_master, non-offline
    // agent gets picked regardless of departments.json / keyword / semantic
    // config — the one deterministic routing outcome this sandboxed fixture
    // (no departments.json, no OPENAI/GOOGLE key) can guarantee. Pinned to the
    // just-created REAL workspace (never the literal 'default' — no box seeds
    // that row outside `npm run db:seed`, so it would 500 the agent create on
    // the same FK the P2-03 task fix already had to solve for tasks.workspace_id).
    const agentRes = await pageFetchJson(page, '/api/agents', {
      method: 'POST',
      body: { name: `E2E QA Master ${Date.now()}`, role: 'CEO', is_master: true, workspace_id: workspace.id },
    });
    expect(agentRes.ok, `POST /api/agents -> ${agentRes.status}`).toBeTruthy();

    // ---- Open the department board, idle (no task of its own submitted) ----
    await page.goto(`/workspace/${workspace.slug}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-walkthrough="column-backlog"]')).toBeVisible();
    await dismissWalkthroughIfPresent(page);

    // ==== PART (b): workspace-scoped board create ===========================
    const titleB = `E2E workspace-create ${Date.now()}`;
    await page.locator('[data-walkthrough="new-task"]').click();
    await expect(page.getByRole('heading', { name: 'Create New Task' })).toBeVisible();
    await page.getByPlaceholder('What needs to be done?').fill(titleB);
    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect(page.locator('[data-testid="task-save-error"]')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByRole('heading', { name: 'Create New Task' })).toHaveCount(0, { timeout: 5_000 });

    const backlogColumn = page.locator('[data-walkthrough="column-backlog"]');
    await expect(backlogColumn.getByText(titleB, { exact: true })).toBeVisible({ timeout: 20_000 });

    // Read back from the REAL API, scoped to this workspace, and assert the
    // row (not just the client store) carries the page's real workspace_id
    // and the canonically-backfilled department — never NULL, never
    // 'default'.
    const tasksInWorkspaceRes = await pageFetchJson<
      Array<{ title: string; workspace_id: string | null; department: string | null; status: string }>
    >(page, `/api/tasks?workspace_id=${encodeURIComponent(workspace.id)}`);
    expect(tasksInWorkspaceRes.ok, `GET /api/tasks?workspace_id=... -> ${tasksInWorkspaceRes.status}`).toBeTruthy();
    const createdB = tasksInWorkspaceRes.body.find((t) => t.title === titleB);
    expect(createdB, 'the workspace-scoped create must be retrievable scoped to its own workspace_id').toBeTruthy();
    expect(
      createdB?.workspace_id,
      'workspace_id must equal the page\'s real workspace id, never NULL/"default"',
    ).toBe(workspace.id);
    expect(
      createdB?.department,
      'department must be backfilled to the canonical slug of the resolved workspace',
    ).toBe(workspace.slug.toLowerCase());
    expect(createdB?.status).toBe('backlog');

    // The card is visible under THIS department's board — the route itself
    // IS the department filter chip (workspace/[slug]/page.tsx locks
    // selectedDepartment to the route), so its presence here already proves
    // department-scoped visibility.

    // ==== PART (c): SSE + instant-routing + persona-pin, via an INDEPENDENT
    //      create the open page did nothing to optimistically render =======
    const beforeCreate = new Date().toISOString();
    const titleC = `E2E sse-broadcast ${Date.now()}`;
    const t0 = Date.now();
    const createRes = await pageFetchJson<{ id: string; workspace_id: string | null }>(page, '/api/tasks', {
      method: 'POST',
      body: { title: titleC, workspace_id: workspace.id },
    });
    const createLatencyMs = Date.now() - t0;
    expect(createRes.ok, `POST /api/tasks -> ${createRes.status}`).toBeTruthy();
    const createdC = createRes.body;
    expect(createdC.id).toBeTruthy();

    // The create response must return fast — proof that persona-pin
    // resolution is kicked off CONCURRENTLY (fire-and-forget) rather than
    // blocking the API response on it (tasks.ts: "Swallow at the source so
    // a background failure never becomes an unhandled rejection").
    expect(
      createLatencyMs,
      `POST /api/tasks took ${createLatencyMs}ms — persona-pin resolution must not block the create response`,
    ).toBeLessThan(5_000);

    // The already-open, already-idle board page must show the new card
    // WITHOUT any navigation or reload — the ONLY delivery mechanism
    // available to it is the task_created SSE broadcast (tasks.ts) received
    // by this page's own useSSE() connection (this create never went through
    // TaskModal's own optimistic addTask()).
    await expect(backlogColumn.getByText(titleC, { exact: true })).toBeVisible({ timeout: 5_000 });

    // Instant routing kicked off and completed: the seeded master agent is
    // the guaranteed CEO/COM last-resort pick, so a `task_dispatched`
    // "Auto-routed:" event must exist for this exact task within a few
    // seconds of creation (bounded poll, no fixed sleep).
    await expect
      .poll(
        async () => {
          const res = await pageFetchJson<Array<{ type: string; task_id: string | null; message: string }>>(
            page,
            `/api/events?since=${encodeURIComponent(beforeCreate)}&limit=100`,
          );
          if (!res.ok) return false;
          return res.body.some(
            (e) => e.type === 'task_dispatched' && e.task_id === createdC.id && e.message.startsWith('Auto-routed:'),
          );
        },
        {
          timeout: 10_000,
          intervals: [250, 500, 1_000],
          message:
            'no task_dispatched "Auto-routed:" event landed for the SSE-broadcast task — instant routing did not kick off',
        },
      )
      .toBe(true);
  });
});
