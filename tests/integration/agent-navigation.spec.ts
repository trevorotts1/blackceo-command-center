/**
 * U58 QC fix-loop — agent-row navigation click-through (BINARY acceptance 5):
 * "ActiveAgentsStrip and department-agents rows navigate to the correct agent
 * detail page (Playwright click-through)."
 *
 * Drives the REAL "click an agent row" flow end-to-end against a live Next
 * server + a real (isolated) SQLite DB — not a mock, not a unit-level render
 * assertion. Covers BOTH row sources the spec names by id:
 *   (a) ActiveAgentsStrip (src/components/ceo-board/redesign/ActiveAgentsStrip.tsx)
 *       on the main /ceo-board overview.
 *   (b) The department-agents section (AgentRow, src/app/ceo-board/[dept]/
 *       page.tsx) on a department detail page.
 *
 * Each row is targeted by its real `href="/agents/<id>"` — a real Link the
 * fix added, not a text-match on copy that could pass without an actual
 * navigable href. After the click, the test asserts BOTH the URL changed to
 * the agent's own detail page AND that page rendered the agent's real name —
 * proving the link points at the correct agent, not just "a" link.
 */

import { test, expect, request, type Page } from 'playwright/test';
import { BASE_URL } from './agent-navigation.fixture';

test.beforeAll(async () => {
  const probe = await request.newContext({ baseURL: BASE_URL });
  try {
    const res = await probe.get('/api/health', { timeout: 10_000 });
    expect(res.ok(), `dev server not reachable at ${BASE_URL}/api/health`).toBeTruthy();
  } finally {
    await probe.dispose();
  }
});

/** Mirrors create-task.spec.ts's unlockDashboard — fires the sanctioned
 *  interview-gate cookie setter and polls until the board is reachable. */
async function unlockDashboard(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto('/interview', { waitUntil: 'domcontentloaded' });
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

/** Mirrors create-task.spec.ts's dismissWalkthroughIfPresent — the first-visit
 *  product walkthrough modal intercepts pointer events until dismissed. */
async function dismissWalkthroughIfPresent(page: Page): Promise<void> {
  const walkthroughSkip = page.getByRole('button', { name: 'Skip' });
  try {
    await walkthroughSkip.waitFor({ state: 'visible', timeout: 5_000 });
    await walkthroughSkip.click();
    await walkthroughSkip.waitFor({ state: 'hidden', timeout: 5_000 });
  } catch {
    // Walkthrough didn't appear — nothing to dismiss.
  }
}

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

test.describe('U58 — agent rows navigate to /agents/[id]', () => {
  test('ActiveAgentsStrip row and department-agents row both click through to the correct agent detail page', async ({
    page,
  }) => {
    await unlockDashboard(page);

    // ---- Seed a real department workspace + a real "working" agent --------
    const wsName = `E2E Nav Dept ${Date.now()}`;
    const wsRes = await pageFetchJson<{ id: string; slug: string; name: string }>(page, '/api/workspaces', {
      method: 'POST',
      body: { name: wsName },
    });
    expect(wsRes.ok, `POST /api/workspaces -> ${wsRes.status}`).toBeTruthy();
    const workspace = wsRes.body;
    expect(workspace.id).toBeTruthy();
    expect(workspace.slug).toBeTruthy();

    const agentName = `E2E Nav Agent ${Date.now()}`;
    const agentRes = await pageFetchJson<{ id: string; name: string }>(page, '/api/agents', {
      method: 'POST',
      body: { name: agentName, role: 'Specialist', workspace_id: workspace.id },
    });
    expect(agentRes.ok, `POST /api/agents -> ${agentRes.status}`).toBeTruthy();
    const agent = agentRes.body;
    expect(agent.id).toBeTruthy();

    // ActiveAgentsStrip only renders agents with status='working' (the real
    // DB CHECK enum — standby/working/offline).
    const statusRes = await pageFetchJson(page, `/api/agents/${agent.id}`, {
      method: 'PATCH',
      body: { status: 'working' },
    });
    expect(statusRes.ok, `PATCH /api/agents/${agent.id} -> ${statusRes.status}`).toBeTruthy();

    // =====================================================================
    // (a) ActiveAgentsStrip on the main /ceo-board overview
    // =====================================================================
    await page.goto('/ceo-board', { waitUntil: 'domcontentloaded' });
    await dismissWalkthroughIfPresent(page);

    const stripLink = page.locator(`a[href="/agents/${agent.id}"]`);
    await expect(stripLink, 'ActiveAgentsStrip must render a real href to this agent').toBeVisible({
      timeout: 15_000,
    });
    await expect(stripLink).toContainText(agentName);

    await stripLink.click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByRole('heading', { name: agentName })).toBeVisible({ timeout: 10_000 });

    // =====================================================================
    // (b) Department-agents section on the department detail page
    // =====================================================================
    await page.goto(`/ceo-board/${workspace.slug}`, { waitUntil: 'domcontentloaded' });
    await dismissWalkthroughIfPresent(page);

    const deptRowLink = page.locator(`a[href="/agents/${agent.id}"]`);
    await expect(deptRowLink, 'the department-agents row must render a real href to this agent').toBeVisible({
      timeout: 15_000,
    });
    await expect(deptRowLink).toContainText(agentName);

    await deptRowLink.click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByRole('heading', { name: agentName })).toBeVisible({ timeout: 10_000 });
  });
});
