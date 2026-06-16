/**
 * Unit tests — bare-task routing runs over the FULL department universe.
 *
 * Regression guard for the post-PR-#93 bug: bare tasks (no department_slug)
 * submitted to POST /api/tasks/ingest were all landing in "General Task" via
 * fallback, never keyword/semantic routing.
 *
 * Root cause: resolveWorkspaceId() returned workspace_id='default' (no CEO
 * workspace matched the slug/name set), then routeTask({workspace_id:'default'})
 * pre-filtered the agent roster to that one workspace via fetchAgentsWithLoad().
 * 'default' has zero agents → routeTask short-circuited to null BEFORE
 * comDispatch ran its keyword/semantic steps → ingest caught null → forced
 * everything to the General Task fallback.
 *
 * Fix: fetchAgentsWithLoad() treats the passed workspace_id as a SOFT hint —
 * it only honours the scoped pre-filter when that workspace has agents;
 * otherwise it returns the FULL roster so comDispatch routes across ALL
 * departments. routeTask only returns null when there are genuinely zero
 * agents anywhere.
 *
 * These tests drive the REAL DB-backed routeTask() (not a mock) against an
 * isolated temp DB seeded with canonical department workspaces + one agent
 * each, plus the buggy zero-agent 'default' workspace. We assert that bare
 * tasks land in the correct department — NOT in General Task — and that the
 * genuinely-ambiguous case still lands in General Task.
 *
 * Embedding keys are unset so routeTask exercises the keyword-scoring path
 * (no network). This matches the box behaviour when no OPENAI/GOOGLE key is
 * configured, and is the deterministic path for CI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-route-bare-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
// Disable embedding keys so routeTask falls through to deterministic keyword
// scoring (no network, no flakiness).
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type RouterModule = typeof import('../../src/lib/routing/department-router');
let routeTask: RouterModule['routeTask'];

const RUN_ID = Math.random().toString(36).slice(2, 10);

// Canonical department workspaces (slug matches DEFAULT_DEPARTMENTS so keyword
// hints are enriched onto the routable dept built from the workspaces table).
const WS = {
  ceo: { id: `ws-ceo-${RUN_ID}`, slug: 'master-orchestrator', name: 'CEO' },
  presentations: { id: `ws-pres-${RUN_ID}`, slug: 'presentations', name: 'Presentations' },
  video: { id: `ws-video-${RUN_ID}`, slug: 'video', name: 'Video Production' },
  sales: { id: `ws-sales-${RUN_ID}`, slug: 'sales', name: 'Sales' },
  finance: { id: `ws-fin-${RUN_ID}`, slug: 'billing-finance', name: 'Billing / Finance' },
  general: { id: `ws-gen-${RUN_ID}`, slug: 'general-task', name: 'General Task' },
};

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // run full migration chain

  const router = (await import('../../src/lib/routing/department-router')) as RouterModule;
  routeTask = router.routeTask;

  const now = new Date().toISOString();

  // Default company (FK target for workspaces).
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );

  // Seed each canonical department workspace.
  let order = 0;
  for (const ws of Object.values(WS)) {
    run(
      `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, '🤖', 'default', ?, ?, ?)`,
      [ws.id, ws.slug, ws.name, order++, now, now],
    );
  }

  // Seed ONE non-offline agent per department workspace (status 'standby' is
  // non-offline so the router includes them). CEO agent is the master.
  const agents: Array<{ id: string; name: string; role: string; ws: string; master: number }> = [
    { id: `ag-ceo-${RUN_ID}`, name: 'Master', role: 'CEO', ws: WS.ceo.id, master: 1 },
    { id: `ag-pres-${RUN_ID}`, name: 'Deck Designer', role: 'Presentation Specialist', ws: WS.presentations.id, master: 0 },
    { id: `ag-video-${RUN_ID}`, name: 'Editor', role: 'Video Editor', ws: WS.video.id, master: 0 },
    { id: `ag-sales-${RUN_ID}`, name: 'Closer', role: 'Sales Agent', ws: WS.sales.id, master: 0 },
    { id: `ag-fin-${RUN_ID}`, name: 'Biller', role: 'Billing Agent', ws: WS.finance.id, master: 0 },
    { id: `ag-gen-${RUN_ID}`, name: 'Generalist', role: 'Head of General Task', ws: WS.general.id, master: 0 },
  ];
  for (const a of agents) {
    run(
      `INSERT OR IGNORE INTO agents (id, name, role, status, is_master, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, 'standby', ?, ?, ?, ?)`,
      [a.id, a.name, a.role, a.master, a.ws, now, now],
    );
  }
  // NOTE: we intentionally seed NO agent in a 'default' workspace, so a bare
  // task routed with workspace_id:'default' would (pre-fix) have produced a
  // zero-agent roster and short-circuited to null.
});

test.after(() => {
  try {
    if (typeof closeDb === 'function') closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── Helper: route a bare task the way the ingest route does (no scope) ────────
async function routeBare(title: string, description = '') {
  return routeTask({ title, description, priority: 'medium' });
}

// ── Helper: route a bare task with the BUGGY scoped 'default' workspace ───────
// Proves the router no longer short-circuits even when handed the wrong scope.
async function routeBareScopedDefault(title: string, description = '') {
  return routeTask({ title, description, priority: 'medium', workspace_id: 'default' });
}

// ── Test 1: pitch deck → Presentations (NOT General Task) ─────────────────────
test('bare "Build a 10-slide investor pitch deck" routes to Presentations, not General Task', async () => {
  const r = await routeBare('Build a 10-slide investor pitch deck');
  assert.ok(r !== null, 'routeTask must not return null for a bare deck task');
  assert.equal(
    r!.department,
    'Presentations',
    `Expected Presentations, got "${r!.department}" (reason: ${r!.reason})`,
  );
  assert.notEqual(r!.department, 'General Task', 'must NOT fall back to General Task');
});

// ── Test 2: promo video → Video Production ────────────────────────────────────
test('bare "Edit this 60-second promo video" routes to Video Production, not General Task', async () => {
  const r = await routeBare('Edit this 60-second promo video');
  assert.ok(r !== null, 'routeTask must not return null for a bare video task');
  assert.equal(
    r!.department,
    'Video Production',
    `Expected Video Production, got "${r!.department}" (reason: ${r!.reason})`,
  );
  assert.notEqual(r!.department, 'General Task');
});

// ── Test 3: cold sales outreach → Sales ───────────────────────────────────────
test('bare "Draft a cold sales outreach email sequence" routes to Sales, not General Task', async () => {
  const r = await routeBare('Draft a cold sales outreach email sequence');
  assert.ok(r !== null, 'routeTask must not return null for a bare sales task');
  assert.equal(
    r!.department,
    'Sales',
    `Expected Sales, got "${r!.department}" (reason: ${r!.reason})`,
  );
  assert.notEqual(r!.department, 'General Task');
});

// ── Test 4: reconcile invoices → Billing / Finance ────────────────────────────
test('bare "Reconcile last month\'s invoices" routes to Billing / Finance, not General Task', async () => {
  const r = await routeBare("Reconcile last month's invoices");
  assert.ok(r !== null, 'routeTask must not return null for a bare finance task');
  assert.equal(
    r!.department,
    'Billing / Finance',
    `Expected Billing / Finance, got "${r!.department}" (reason: ${r!.reason})`,
  );
  assert.notEqual(r!.department, 'General Task');
});

// ── Test 5: genuinely ambiguous → General Task (true last resort) ─────────────
test('bare "Do something interesting" routes to General Task (genuine ambiguity)', async () => {
  const r = await routeBare('Do something interesting');
  assert.ok(r !== null, 'routeTask must not return null');
  assert.equal(
    r!.department,
    'General Task',
    `Expected General Task catch-all for ambiguous input, got "${r!.department}" (reason: ${r!.reason})`,
  );
});

// ── Test 6: the EXACT bug path — scoped 'default' must NOT short-circuit ───────
// Even if a caller passes the buggy scoped 'default' workspace, the router must
// fall through to the full roster and route correctly (never blank to null /
// General Task).
test('bare deck task with buggy workspace_id="default" scope still routes to Presentations', async () => {
  const r = await routeBareScopedDefault('Build a 10-slide investor pitch deck');
  assert.ok(
    r !== null,
    'routeTask must NOT short-circuit to null when a zero-agent "default" scope is passed',
  );
  assert.equal(
    r!.department,
    'Presentations',
    `Expected Presentations even with default scope, got "${r!.department}" (reason: ${r!.reason})`,
  );
});

// ── Test 7: a real, populated workspace scope is still honoured as a hint ──────
// Passing a workspace that HAS agents must still scope-prefer it (the soft
// hint behaviour is preserved for the populated case). The Sales workspace has
// a Sales agent; a sales task scoped to it routes to Sales.
test('populated workspace scope is honoured (soft hint preserved) for a sales task', async () => {
  const r = await routeTask({
    title: 'Draft a cold sales outreach email sequence',
    description: '',
    priority: 'medium',
    workspace_id: WS.sales.id,
  });
  assert.ok(r !== null);
  assert.equal(r!.department, 'Sales', `Expected Sales, got "${r!.department}"`);
});
