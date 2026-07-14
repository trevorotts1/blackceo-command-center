/**
 * U60 / JM-U63d — POST /api/ceo-chat/task (My AI CEO delegate-task control).
 *
 * Drives the REAL route handler (a NextRequest, never a mock) against an
 * isolated temp DB, mirroring tests/unit/ingest-requester-stamp.test.ts and
 * tests/unit/create-task-null-fields.test.ts:
 *
 *   A. explicit department pick -> task lands in EXACTLY that department
 *      (fixture asserts equality) — never floored/capped/re-routed.
 *   B. every task created via the control carries BOTH requester stamps
 *      (requester_channel='ceo-chat', requester_chat_id=sessionId) — SQL
 *      assert against the fixture database.
 *   C. unrecognized explicit department -> 400, not a silent reroute.
 *   D. auto path with zero agents seeded -> falls back to the general-task
 *      workspace (mirrors the ingest route's own fallback chain) and reports
 *      resolved_by accordingly.
 *   E. missing sessionId / title -> 400.
 *   F. MY_AI_CEO_BETA=false -> 404 (BETA gate honored on this route too).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// ── Isolated DB (set BEFORE @/lib/db / the route module are imported) ───────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ceo-chat-task-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.MY_AI_CEO_BETA;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const SALES_WS_ID = `ws-sales-${RUN_ID}`;
const GENERAL_WS_ID = `ws-general-${RUN_ID}`;
const SESSION_ID = `sess-ceo-chat-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/ceo-chat/task/route');
let POST: RouteModule['POST'];

function callDelegate(payload: Record<string, unknown>): Promise<Response> {
  const req = new NextRequest('http://localhost/api/ceo-chat/task', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return POST(req) as unknown as Promise<Response>;
}

function taskRow(id: string) {
  const row = queryOne<{
    id: string;
    department: string | null;
    requester_channel: string | null;
    requester_chat_id: string | null;
  }>('SELECT id, department, requester_channel, requester_chat_id FROM tasks WHERE id = ?', [id]);
  assert.ok(row, `created task ${id} must exist`);
  return row!;
}

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
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'sales', 'Sales', '💰', 'default', 1, ?, ?)`,
    [SALES_WS_ID, now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'general-task', 'General Task', '📋', 'default', 99, ?, ?)`,
    [GENERAL_WS_ID, now, now],
  );

  const route = (await import('../../src/app/api/ceo-chat/task/route')) as RouteModule;
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

test('explicit department pick lands the task in EXACTLY that department, with both requester stamps', async () => {
  const res = await callDelegate({
    sessionId: SESSION_ID,
    title: `Explicit-pick task ${RUN_ID}`,
    departmentSlug: 'sales',
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.department, 'sales');
  assert.equal(body.resolved_by, 'explicit:sales');

  const row = taskRow(body.taskId);
  assert.equal(row.department, 'sales');
  assert.equal(row.requester_channel, 'ceo-chat');
  assert.equal(row.requester_chat_id, SESSION_ID);
});

test('auto path with zero agents seeded falls back to general-task, with both requester stamps', async () => {
  const res = await callDelegate({
    sessionId: SESSION_ID,
    title: `Auto-route task ${RUN_ID}`,
    departmentSlug: 'auto',
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.department, 'general-task');
  assert.equal(body.resolved_by, 'auto-route:general-task-fallback');

  const row = taskRow(body.taskId);
  assert.equal(row.department, 'general-task');
  assert.equal(row.requester_channel, 'ceo-chat');
  assert.equal(row.requester_chat_id, SESSION_ID);
});

test('omitting departmentSlug behaves identically to "auto"', async () => {
  const res = await callDelegate({ sessionId: SESSION_ID, title: `Bare task ${RUN_ID}` });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.department, 'general-task');
});

test('an unrecognized explicit department is a 400, never a silent reroute', async () => {
  const res = await callDelegate({
    sessionId: SESSION_ID,
    title: `Bad dept task ${RUN_ID}`,
    departmentSlug: 'not-a-real-department',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('missing title -> 400', async () => {
  const res = await callDelegate({ sessionId: SESSION_ID });
  assert.equal(res.status, 400);
});

test('missing sessionId -> 400', async () => {
  const res = await callDelegate({ title: 'No session' });
  assert.equal(res.status, 400);
});

test('MY_AI_CEO_BETA=false -> 404', async () => {
  process.env.MY_AI_CEO_BETA = 'false';
  try {
    const res = await callDelegate({ sessionId: SESSION_ID, title: 'Should 404' });
    assert.equal(res.status, 404);
  } finally {
    delete process.env.MY_AI_CEO_BETA;
  }
});
