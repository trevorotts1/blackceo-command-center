/**
 * U41 (C/C-10, master spec `skill6-blended-persona-kanban-MASTER-SPEC-v2`)
 * — instant in-process routing must never clobber the canonical-slug
 * department backfill with a raw display name.
 *
 * Root cause (discovered while writing U41's Playwright coverage for a
 * workspace-scoped board create): `createTaskCore` (src/lib/tasks.ts)
 * correctly backfills `tasks.department` to the canonical slug of the
 * resolved workspace on INSERT (the "Department backfill (UI-created-task
 * visibility fix)" block). But the INSTANT ROUTING block that runs right
 * after — when it finds an agent — issues a SECOND write:
 *
 *   UPDATE tasks SET assigned_agent_id = ?, department = ?, ... WHERE id = ?
 *
 * using `routing.department`, which `comDispatch()` (department-router.ts)
 * populates from `DepartmentConfig.name` (the DISPLAY name, e.g. "Marketing")
 * on every one of its return sites — even though `DepartmentConfig.id`'s own
 * doc comment says that field, not `.name`, is "used in task.department
 * field". The UPDATE silently overwrote the correct canonical slug with the
 * raw display name whenever routing successfully assigned an agent — which
 * is precisely the common case (a task created inside a department's own
 * workspace, whose title naturally overlaps the department's own name,
 * keyword-matches that SAME department, load balances to one of its agents).
 *
 * Downstream impact: the board's department filter chip compares
 * `task.department === selectedDepartment`, a lowercase workspace-slug
 * string (`workspace/[slug]/page.tsx`). A task whose `department` column
 * held the display name instead of the slug would silently vanish from its
 * own department-scoped board view the moment routing assigned it an agent
 * — a second, narrower instance of the exact "task doesn't show up where I
 * expect it" failure class C-10 exists to close.
 *
 * FAIL-FIRST: before this fix, `resolvedTask.department` below reads back
 * as the raw display name "Widgets Test Department" (or similar), NOT the
 * canonical slug "widgets-test-department" — this assertion fails against
 * pre-fix `src/lib/tasks.ts`. With the fix (resolve `routing.department`
 * back to the real workspace slug — or `canonicalDeptSlug()`'s graceful
 * degradation when no workspace row matches — before persisting it), the
 * canonical slug is what lands, and this test passes.
 *
 * Strategy mirrors tests/unit/create-task-null-fields.test.ts: isolated temp
 * DB, seed the workspace + a routable agent directly, invoke the REAL POST
 * handler (src/app/api/tasks/route.ts) with a NextRequest — never a mock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

// ── Isolated DB (set BEFORE @/lib/db / the route module are imported) ───────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-routed-dept-slug-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
// No embedding keys → routing stays on the deterministic keyword-scoring
// fallback path (never the semantic/LLM-tiebreak path), so the ONE seeded
// department is guaranteed to be the routing engine's only candidate.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

const RUN_ID = Math.random().toString(36).slice(2, 10);
// Deliberately DIFFERENT from the slug — the whole point of this test is
// that the NAME must never leak into tasks.department.
const DEPT_NAME = `Widgets Test Department ${RUN_ID}`;
const DEPT_SLUG = `widgets-test-department-${RUN_ID}`;
const WS_ID = `ws-${DEPT_SLUG}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/tasks/route');
let POST: RouteModule['POST'];

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // runs the full migration chain against the temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  // Name/slug DELIBERATELY differ (real seeded departments.json departments
  // routinely have "Marketing" / "marketing", "Video Production" / "video",
  // etc.) so a fix that only worked when name===slug would still be caught.
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, '🧩', 'default', 1, ?, ?)`,
    [WS_ID, DEPT_SLUG, DEPT_NAME, now, now],
  );
  // A role-fit, non-master agent scoped to this workspace — pickBestAgent's
  // ordinary role-fit path, not the CEO/COM last-resort fallback, so this
  // test exercises the COMMON routing outcome (keyword match on the task's
  // OWN department), not the degenerate no-match case.
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, avatar_emoji, status, is_master, specialist_type, workspace_id, created_at, updated_at)
     VALUES (?, 'Widgets Specialist', 'Specialist', '🤖', 'standby', 0, 'permanent', ?, ?, ?)`,
    [`agent-${DEPT_SLUG}`, WS_ID, now, now],
  );

  const route = (await import('../../src/app/api/tasks/route')) as RouteModule;
  POST = route.POST;
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

test('instant routing to an agent must persist the CANONICAL SLUG in tasks.department, never the department display name', async () => {
  // The title deliberately echoes a keyword from the department's DISPLAY
  // NAME ("Widgets") — the realistic case of a task created inside (or
  // about) its own department, which keyword-scores a match against that
  // SAME department and routes to its agent. This is the exact condition
  // that triggered the pre-fix clobber.
  const title = `Handle a new Widgets Test Department order ${RUN_ID}`;
  const req = new NextRequest('http://localhost/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title,
      description: '',
      priority: 'medium',
      status: 'backlog',
      assigned_agent_id: null,
      due_date: null,
      workspace_id: WS_ID,
    }),
  });
  const res = (await POST(req)) as unknown as Response;
  const bodyText = await res.clone().text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
  const body = (await res.json()) as { id: string; assigned_agent_id: string | null; department: string | null };

  // Routing must actually have fired and assigned the seeded agent — if it
  // didn't (e.g. keyword scoring changed upstream), this test isn't
  // exercising the clobber path at all, so fail loudly rather than pass for
  // the wrong reason.
  assert.equal(
    body.assigned_agent_id,
    `agent-${DEPT_SLUG}`,
    'routing must assign the seeded department agent for this test to be meaningful',
  );

  // The row `department` column — read back independently from the API
  // response, straight from the DB — must be the canonical slug, never the
  // raw "Widgets Test Department <run>" display name comDispatch returned.
  const row = queryOne<{ department: string | null }>('SELECT department FROM tasks WHERE id = ?', [body.id]);
  assert.ok(row, 'the created task must be persisted');
  assert.equal(
    row!.department,
    DEPT_SLUG,
    `tasks.department must be the canonical workspace slug "${DEPT_SLUG}", ` +
      `never the display name "${DEPT_NAME}" — the board's department filter ` +
      `chip compares against the slug (workspace/[slug]/page.tsx).`,
  );
  assert.equal(body.department, DEPT_SLUG, 'the API response must reflect the same canonical slug');
});

test('a routed department with no matching workspace row falls back to canonicalDeptSlug (graceful degradation), never throws', async () => {
  // The CEO/COM last-resort sentinel ("CEO / COM") has no workspace row by
  // design — guard that the lookup-miss path degrades gracefully (via
  // canonicalDeptSlug's own documented fallback) instead of crashing the
  // create. Seed a second, unrelated agent as an is_master fallback so this
  // task (whose title shares no keywords with "Widgets") still gets routed
  // somewhere, exercising the CEO/COM step.
  const now = new Date().toISOString();
  const masterId = `agent-master-${RUN_ID}`;
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, avatar_emoji, status, is_master, specialist_type, workspace_id, created_at, updated_at)
     VALUES (?, 'CEO Master', 'CEO', '👑', 'standby', 1, 'permanent', ?, ?, ?)`,
    [masterId, WS_ID, now, now],
  );

  const title = `Completely unrelated task with no department keywords ${RUN_ID}`;
  const req = new NextRequest('http://localhost/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title,
      description: '',
      priority: 'medium',
      status: 'backlog',
      assigned_agent_id: null,
      due_date: null,
      workspace_id: WS_ID,
    }),
  });
  const res = (await POST(req)) as unknown as Response;
  const bodyText = await res.clone().text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
  const body = (await res.json()) as { id: string; department: string | null };

  const row = queryOne<{ department: string | null }>('SELECT department FROM tasks WHERE id = ?', [body.id]);
  assert.ok(row, 'the created task must be persisted even when routing lands on the no-workspace-row sentinel');
  // Never the raw un-canonicalized sentinel string, whatever it degrades to.
  assert.notEqual(row!.department, 'CEO / COM');
});
