/**
 * P2-03 — POST /api/tasks must never crash with an uncaught FK constraint
 * error when the supplied `workspace_id` doesn't resolve to a real row.
 *
 * Root cause (live reproduction): TaskModal.handleSubmit()
 * (src/components/TaskModal.tsx) previously fell back to the LITERAL string
 * `'default'` for workspace_id whenever it had no real workspace context —
 * exactly the case on the cross-department /tasks/all board, which passes no
 * `workspaceId` prop, for a brand-new task. No box seeds a workspaces row with
 * id 'default' outside the standalone `npm run db:seed` script (the on-boot
 * auto-seed path, `reseedWorkspacesFromConfig`, seeds only real
 * departments.json-derived slugs, never the literal 'default' sentinel) — so
 * this payload carried a PHANTOM workspace id on a normally-provisioned box.
 *
 * createTaskCore's own resolution code (src/lib/tasks.ts) looked the id up,
 * found no row, but — despite a comment at the top of the function claiming
 * "we leave workspace_id NULL rather than inserting a nonexistent 'default'
 * row" — left `workspaceId` holding the phantom value anyway. That value then
 * reached `INSERT INTO tasks (..., workspace_id, ...)`, which throws
 * SQLITE_CONSTRAINT_FOREIGNKEY. The throw is UNCAUGHT inside createTaskCore
 * (it's outside any try/catch there) and propagates straight through
 * route.ts's outer try/catch failing to save it gracefully in exactly the
 * way — a raw framework 500 with no usable JSON body, rather than the route's
 * intended `{ error: 'Failed to create task' }` 500 — that produced the
 * operator's "create task doesn't really work" report.
 *
 * FAIL-FIRST: against the pre-fix src/lib/tasks.ts this test's first two
 * cases throw (an uncaught exception during POST, surfaced here as the
 * promise itself rejecting rather than resolving with a Response) or 500. With
 * the fix (null the id on a lookup miss instead of keeping the phantom value)
 * both return 201 with workspace_id: null persisted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-phantom-ws-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

const RUN_ID = Math.random().toString(36).slice(2, 10);

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/tasks/route');
let POST: RouteModule['POST'];

function callCreate(overrides: Record<string, unknown> = {}): Promise<Response> {
  const payload = {
    title: `Untitled phantom-ws ${RUN_ID}`,
    description: '',
    priority: 'medium',
    status: 'backlog',
    assigned_agent_id: null,
    due_date: null,
    ...overrides,
  };
  const req = new NextRequest('http://localhost/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return POST(req) as unknown as Promise<Response>;
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // runs the full migration chain against the temp DB — deliberately
  // NO workspace seeding at all here: this is the "on-boot auto-seed never
  // ran (unbranded/fresh box) and `npm run db:seed` was never run either"
  // state, which is exactly the state a real box can be in.

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

// ── The exact TaskModal-on-/tasks/all phantom payload: workspace_id:'default'
//    with NO such row in the workspaces table. ───────────────────────────────
test('create with workspace_id:"default" and no such row does NOT throw / 500 — persists with workspace_id NULL', async () => {
  const res = await callCreate({ workspace_id: 'default' });
  const bodyText = await res.clone().text().catch(() => '<unreadable body>');
  assert.equal(
    res.status,
    201,
    `expected 201, got ${res.status}. Body: ${bodyText}. A workspace_id that ` +
      `doesn't resolve to a real row must never crash task creation.`,
  );
  const body = (await res.json()) as { id: string; workspace_id: string | null };
  assert.equal(
    body.workspace_id,
    null,
    'an unresolvable workspace_id must be persisted as NULL, never the phantom value',
  );

  const row = queryOne<{ workspace_id: string | null }>(
    'SELECT workspace_id FROM tasks WHERE id = ?',
    [body.id],
  );
  assert.ok(row, 'the created task must actually be persisted');
  assert.equal(row!.workspace_id, null);
});

// ── Any other unresolvable workspace_id (not just the literal 'default')
//    must be handled the same way. ───────────────────────────────────────────
test('create with a random unresolvable workspace_id does NOT throw / 500', async () => {
  const res = await callCreate({
    title: `Untitled phantom-ws B ${RUN_ID}`,
    workspace_id: `ws-does-not-exist-${RUN_ID}`,
  });
  const bodyText = await res.clone().text().catch(() => '<unreadable body>');
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
  const body = (await res.json()) as { workspace_id: string | null };
  assert.equal(body.workspace_id, null);
});

// ── Guard: a REAL workspace_id must still resolve correctly (the fix must not
//    null out valid ids). ────────────────────────────────────────────────────
test('create with a REAL workspace_id still resolves and persists it', async () => {
  const now = new Date().toISOString();
  const wsId = `ws-real-${RUN_ID}`;
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'sales', 'Sales', '💰', 'default', 1, ?, ?)`,
    [wsId, now, now],
  );
  const res = await callCreate({ title: `Untitled phantom-ws C ${RUN_ID}`, workspace_id: wsId });
  const bodyText = await res.clone().text().catch(() => '<unreadable body>');
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
  const body = (await res.json()) as { workspace_id: string | null };
  assert.equal(body.workspace_id, wsId, 'a REAL workspace_id must resolve and persist unchanged');
});
