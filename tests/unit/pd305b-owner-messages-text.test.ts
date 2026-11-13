/**
 * PD-305b — the owner-message text route.
 *
 * GET /api/tasks/[id]/messages/owner-messages returns the owner's messages on
 * one task WITH their text, oldest first:
 *   [{ id, text, created_at }]
 *
 * The owner test is the one already used by the owner-ids oracle
 * (src/lib/owner-message-ids.ts: `activity_type = 'owner_message'`, the
 * exclusive marker the messages POST route writes for sender !== 'agent'), so
 * an agent message and a non-message activity on the same task are absent here
 * exactly as they are absent from the oracle's id set.
 *
 * The credential gate is the GLOBAL middleware (MC_API_TOKEN for external
 * /api/* callers, same-origin passthrough for the board). src/middleware.ts
 * matches every route (`matcher` in src/middleware.ts), so this route inherits
 * the existing refusal. A handler-level test cannot prove middleware behavior
 * (it never runs the middleware), so the tests below prove the handler adds no
 * check of its own and returns 200 for the same calls the owner-ids route
 * accepts.
 *
 * Real route handler, real NextRequest, throwaway DB (_isolated-db.ts).
 */

import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.

// Pin the active company BEFORE any handler call (resolveSeedingCompanyId reads
// process.env at call time and an exact COMPANY_SLUG match wins).
process.env.COMPANY_SLUG = 'pd305b-company';

import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { getDb } from '../../src/lib/db';
import { GET as ownerMessagesGET } from '../../src/app/api/tasks/[id]/messages/owner-messages/route';

/* ─────────────────────────────── fixtures ───────────────────────────────── */

const COMPANY_ID = 'pd305b-company-id';
const OWN_WORKSPACE = 'pd305b-own-workspace';
const FOREIGN_COMPANY_ID = 'pd305b-foreign-company-id';
const FOREIGN_WORKSPACE = 'pd305b-foreign-workspace';

function seedCompanies(): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, 'PD-305b Company', 'pd305b-company', '{}', ?, ?)`,
  ).run(COMPANY_ID, now, now);
  db.prepare(
    `INSERT OR REPLACE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, 'PD-305b Foreign Company', 'pd305b-foreign-company', '{}', ?, ?)`,
  ).run(FOREIGN_COMPANY_ID, now, now);
}

function seedWorkspace(id: string, slug: string, companyId: string): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO workspaces (id, name, slug, description, icon, company_id, sort_order)
       VALUES (?, 'PD-305b Workspace', ?, 'fixture', '📁', ?, 100)`,
    )
    .run(id, slug, companyId);
}

function seedTask(id: string, workspaceId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, department, source, created_at, updated_at)
       VALUES (?, ?, 'in_progress', 'medium', ?, 'default', 'presentations', 'pd305b-test', ?, ?)`,
    )
    .run(id, `task ${id}`, workspaceId, now, now);
}

function seedAgent(id: string, workspaceId: string): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO agents (id, name, role, status, workspace_id)
       VALUES (?, 'Test Agent', 'worker', 'standby', ?)`,
    )
    .run(id, workspaceId);
}

function seedActivity(
  taskId: string,
  id: string,
  activityType: string,
  message: string,
  createdAt: string,
  agentId: string | null = null,
): void {
  getDb()
    .prepare(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, taskId, agentId, activityType, message, createdAt);
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function callRoute(taskId: string, headers: Record<string, string> = {}) {
  const res = await ownerMessagesGET(
    new NextRequest(`http://localhost/api/tasks/${taskId}/messages/owner-messages`, { headers }),
    ctx(taskId),
  );
  return { res, body: (await res.json()) as unknown };
}

test.before(() => {
  seedCompanies();
  seedWorkspace(OWN_WORKSPACE, 'pd305b-own', COMPANY_ID);
  seedWorkspace(FOREIGN_WORKSPACE, 'pd305b-foreign', FOREIGN_COMPANY_ID);
  seedAgent('pd305b-agent-1', OWN_WORKSPACE);
});

/* ═══════════════════════════ PD-305b acceptance ═══════════════════════════ */

// A1 — owner messages come back with their text, oldest first.
test('PD-305b A1: owner messages come back with their text, oldest first', async () => {
  const TASK = 'pd305b-task-text-1';
  seedTask(TASK, OWN_WORKSPACE);
  // Inserted newest-first on purpose: the response order must come from
  // created_at, not from insertion order or id order.
  seedActivity(TASK, 'pd305b-msg-newest', 'owner_message', 'ship it', '2026-11-12T15:00:00.000Z');
  seedActivity(TASK, 'pd305b-msg-oldest', 'owner_message', 'yes, the gate is approved', '2026-11-12T13:00:00.000Z');
  seedActivity(TASK, 'pd305b-msg-middle', 'owner_message', 'hold the third slide', '2026-11-12T14:00:00.000Z');

  const { res, body } = await callRoute(TASK);

  assert.equal(res.status, 200);
  assert.deepEqual(body, [
    { id: 'pd305b-msg-oldest', text: 'yes, the gate is approved', created_at: '2026-11-12T13:00:00.000Z' },
    { id: 'pd305b-msg-middle', text: 'hold the third slide', created_at: '2026-11-12T14:00:00.000Z' },
    { id: 'pd305b-msg-newest', text: 'ship it', created_at: '2026-11-12T15:00:00.000Z' },
  ]);
});

// A2 — a message on the same task written by a non-owner is absent.
test('PD-305b A2: a non-owner message on the same task is absent', async () => {
  const TASK = 'pd305b-task-mixed-1';
  seedTask(TASK, OWN_WORKSPACE);
  seedActivity(TASK, 'pd305b-own-1', 'owner_message', 'owner words', '2026-11-12T13:00:00.000Z');
  seedActivity(TASK, 'pd305b-agent-msg-1', 'agent_message', 'agent words', '2026-11-12T14:00:00.000Z', 'pd305b-agent-1');
  seedActivity(TASK, 'pd305b-status-1', 'status_changed', 'status words', '2026-11-12T15:00:00.000Z');
  seedActivity(TASK, 'pd305b-plain-msg-1', 'message', 'plain message words', '2026-11-12T16:00:00.000Z');

  const { res, body } = await callRoute(TASK);

  assert.equal(res.status, 200);
  const rows = body as Array<{ id: string; text: string }>;
  assert.deepEqual(rows.map((row) => row.id), ['pd305b-own-1']);
  assert.ok(!rows.some((row) => row.id === 'pd305b-agent-msg-1'), 'an agent message must be absent');
  assert.ok(!rows.some((row) => row.id === 'pd305b-status-1'), 'a non-message activity must be absent');
  assert.ok(!rows.some((row) => row.id === 'pd305b-plain-msg-1'), 'a non-owner plain message must be absent');
});

// The empty case the engine relies on: a known task with no owner messages is
// 200 + [], never an error.
test('PD-305b: a task with no owner messages returns 200 + []', async () => {
  const TASK = 'pd305b-task-empty-1';
  seedTask(TASK, OWN_WORKSPACE);
  seedActivity(TASK, 'pd305b-empty-agent-1', 'agent_message', 'agent only', '2026-11-12T13:00:00.000Z', 'pd305b-agent-1');

  const { res, body } = await callRoute(TASK);

  assert.equal(res.status, 200);
  assert.deepEqual(body, []);
});

// A3 (handler half) — the route adds no credential check of its own; the
// existing MC_API_TOKEN middleware gate is inherited by path. A call with no
// Authorization header reaches the handler and behaves like the owner-ids
// route's handler does.
test('PD-305b A3: the handler carries no route-level credential gate (middleware is the gate)', async () => {
  const TASK = 'pd305b-task-auth-1';
  seedTask(TASK, OWN_WORKSPACE);
  seedActivity(TASK, 'pd305b-auth-own-1', 'owner_message', 'approved', '2026-11-12T13:00:00.000Z');

  const { res } = await callRoute(TASK); // no headers at all

  assert.equal(res.status, 200, 'the middleware, not the handler, refuses a caller without the credential');
});

// Unknown task, and a task owned by another company: both 404, so the route is
// not an existence oracle.
test('PD-305b: an unknown task and a foreign-company task are both 404', async () => {
  const FOREIGN_TASK = 'pd305b-task-foreign-1';
  seedTask(FOREIGN_TASK, FOREIGN_WORKSPACE);
  seedActivity(FOREIGN_TASK, 'pd305b-foreign-own-1', 'owner_message', 'not this box', '2026-11-12T13:00:00.000Z');

  const unknown = await callRoute('pd305b-task-does-not-exist');
  assert.equal(unknown.res.status, 404);

  const foreign = await callRoute(FOREIGN_TASK);
  assert.equal(foreign.res.status, 404);
  assert.deepEqual(foreign.body, { error: 'Task not found' });
});
