/**
 * WIR-121 (spec 16.2 A11, GAP1/GAP2) — FAIL-FIRST.
 *
 * Spec 12.2 doors POST /api/tasks (UI create) and POST /api/ceo-chat/task
 * (CEO-chat delegate control) must run raw conversational text through the
 * EXISTING intake module (classify() + assertTaskCreationAllowed from
 * '@/lib/intake') and suppress non-work verdicts with NO card and NO entry
 * into the dispatch chain (createTaskCore -> routeTaskDecision /
 * commitIntakeAssignment -> autoDispatchTask, all downstream of the INSERT).
 *
 *   1. UI door + answer_only ("What does Marketing do?") -> 200
 *      created:false, tasks +0, events +0 (GAP2: dispatch entry never ran —
 *      it is reachable only after a card INSERT, which also writes a
 *      task_created event; both counts at zero proves neither ran).
 *   2. UI door + social ("Thanks.") -> same suppression.
 *   3. UI door + genuine task_request -> 201, exactly one card (control:
 *      without it the suppression asserts are trivially satisfiable by a
 *      broken door).
 *   4. CEO door + answer_only -> 200 created:false, tasks +0, events +0.
 *   5. CEO door + genuine task_request -> 201, exactly one card (control).
 *
 * Drives the REAL POST handlers (NextRequest, never a mock) against an
 * isolated temp DB, mirroring tests/unit/create-task-requester-stamp.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// ── Isolated DB (set BEFORE @/lib/db / route modules are imported) ──────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-wir121-a11-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.MY_AI_CEO_BETA;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const SALES_WS_ID = `ws-sales-${RUN_ID}`;
const GENERAL_WS_ID = `ws-general-${RUN_ID}`;
const SESSION_ID = `sess-wir121-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let queryOne: DbModule['queryOne'];
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];

type TasksRouteModule = typeof import('../../src/app/api/tasks/route');
let TASKS_POST: TasksRouteModule['POST'];
type CeoRouteModule = typeof import('../../src/app/api/ceo-chat/task/route');
let CEO_POST: CeoRouteModule['POST'];

function taskCount(): number {
  return queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM tasks', [])!.n;
}
function eventCount(): number {
  return queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM events', [])!.n;
}

function callUiCreate(title: string): Promise<Response> {
  const req = new NextRequest('http://localhost/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, workspace_id: SALES_WS_ID }),
  });
  return TASKS_POST(req) as unknown as Promise<Response>;
}

function callCeoDelegate(title: string): Promise<Response> {
  const req = new NextRequest('http://localhost/api/ceo-chat/task', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, title, departmentSlug: 'sales' }),
  });
  return CEO_POST(req) as unknown as Promise<Response>;
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // full migration chain against the temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'sales', 'Sales', 'X', 'default', 1, ?, ?)`,
    [SALES_WS_ID, now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'general-task', 'General Task', 'X', 'default', 99, ?, ?)`,
    [GENERAL_WS_ID, now, now],
  );

  TASKS_POST = ((await import('../../src/app/api/tasks/route')) as TasksRouteModule).POST;
  CEO_POST = ((await import('../../src/app/api/ceo-chat/task/route')) as CeoRouteModule).POST;
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

// ── 1. UI door suppresses answer_only: ZERO cards, dispatch entry never ran ──
test('UI create with an answer_only message creates ZERO cards and never enters dispatch', async () => {
  const tasksBefore = taskCount();
  const eventsBefore = eventCount();
  const res = await callUiCreate('What does Marketing do?');
  const body = (await res.json()) as { ok: boolean; created: boolean; intent: string; task_id: null };
  assert.equal(res.status, 200, `suppressed intake must return 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.created, false, 'answer_only must not create a card');
  assert.equal(body.intent, 'answer_only', 'verdict must be the classifier answer_only intent');
  assert.equal(body.task_id, null, 'no task id on a suppressed intake');
  assert.equal(taskCount(), tasksBefore, 'ZERO new task rows for answer_only');
  assert.equal(eventCount(), eventsBefore, 'ZERO new event rows: dispatch entry never ran');
});

// ── 2. UI door suppresses social_conversation ─────────────────────────────────
test('UI create with a social message creates ZERO cards', async () => {
  const tasksBefore = taskCount();
  const eventsBefore = eventCount();
  const res = await callUiCreate('Thanks.');
  const body = (await res.json()) as { ok: boolean; created: boolean; intent: string; task_id: null };
  assert.equal(res.status, 200, `suppressed intake must return 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.created, false, 'social_conversation must not create a card');
  assert.equal(body.intent, 'social_conversation', 'verdict must be the classifier social_conversation intent');
  assert.equal(taskCount(), tasksBefore, 'ZERO new task rows for social_conversation');
  assert.equal(eventCount(), eventsBefore, 'ZERO new event rows: dispatch entry never ran');
});

// ── 3. UI door positive control: genuine task_request creates exactly one ────
test('UI create with a genuine task_request creates EXACTLY ONE card (control)', async () => {
  const tasksBefore = taskCount();
  const res = await callUiCreate(`Create the Q3 sales campaign ${RUN_ID}`);
  const bodyText = await res.clone().text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
  const body = (await res.json()) as { id: string };
  assert.ok(body.id, 'created card must carry an id');
  assert.equal(taskCount(), tasksBefore + 1, 'EXACTLY ONE new task row for task_request');
});

// ── 4. CEO door suppresses answer_only ───────────────────────────────────────
test('CEO-chat delegate with an answer_only message creates ZERO cards and never enters dispatch', async () => {
  const tasksBefore = taskCount();
  const eventsBefore = eventCount();
  const res = await callCeoDelegate('What does Marketing do?');
  const body = (await res.json()) as { ok: boolean; created: boolean; intent: string; task_id: null };
  assert.equal(res.status, 200, `suppressed intake must return 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.created, false, 'answer_only must not create a card');
  assert.equal(body.intent, 'answer_only', 'verdict must be the classifier answer_only intent');
  assert.equal(taskCount(), tasksBefore, 'ZERO new task rows for answer_only');
  assert.equal(eventCount(), eventsBefore, 'ZERO new event rows: dispatch entry never ran');
});

// ── 5. CEO door positive control ─────────────────────────────────────────────
test('CEO-chat delegate with a genuine task_request creates EXACTLY ONE card (control)', async () => {
  const tasksBefore = taskCount();
  const res = await callCeoDelegate(`Create the Q3 sales CEO campaign ${RUN_ID}`);
  const bodyText = await res.clone().text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
  const body = (await res.json()) as { ok: boolean; taskId: string };
  assert.ok(body.taskId, 'created card must carry a taskId');
  assert.equal(taskCount(), tasksBefore + 1, 'EXACTLY ONE new task row for task_request');
});
