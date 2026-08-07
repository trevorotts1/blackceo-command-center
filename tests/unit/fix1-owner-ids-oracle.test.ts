/**
 * FIX-1 CC side — owner-ids oracle route test.
 *
 * THE GATE (GAUNTLET LOOP, FIX-1 CC-side row):
 *   GET /api/tasks/[id]/messages/owner-ids returns the REAL owner-authored
 *   message ids for a task (from task_activities), and a FORGED id is ABSENT
 *   from the set.
 *
 * The presentation engine's phase-skip authenticity gate (cc_board
 * .list_owner_message_ids -> load_skip_approvals) resolves an owner_msg_id
 * through exactly this route: a real owner message id must appear in the
 * response, a forged id (the live E2E used "e2e-test-002") must NOT.
 *
 * These tests drive the REAL route handler with a REAL NextRequest against a
 * throwaway DB (tests/unit/_isolated-db.ts), seeding owner/agent messages the
 * same way the messages POST route does:
 *   - owner message  = activity_type 'owner_message'  (sender === 'owner')
 *   - agent message  = activity_type 'agent_message'  (sender === 'agent')
 *   - non-message activity = any other type (status_changed, spawned, ...)
 *
 * The oracle must return ONLY owner-authored message ids — an agent message id
 * and a non-message activity id are exactly as forged as "e2e-test-002".
 */

import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { getDb } from '../../src/lib/db';
import { GET as ownerIdsGET } from '../../src/app/api/tasks/[id]/messages/owner-ids/route';
import { listOwnerMessageIds } from '../../src/lib/owner-message-ids';

/* ─────────────────────────────── fixtures ───────────────────────────────── */

// A fresh isolated DB seeds ONLY the anthology/podcast workspaces, so a fixture
// must create its own workspace + agent (FK enforcement is ON). Everything here
// is generic fixture data — no client or roster names.
const FIXTURE_WORKSPACE = 'fixture-workspace';
const FIXTURE_AGENT = 'fixture-agent-1';

function seedWorkspace(): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO workspaces (id, name, slug, description, icon, company_id, sort_order)
       VALUES (?, 'Fixture Workspace', ?, 'fixture', '📁', 'default', 100)`,
    )
    .run(FIXTURE_WORKSPACE, FIXTURE_WORKSPACE);
}

function seedTask(id: string): void {
  seedWorkspace();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO tasks (id, title, description, status, priority, workspace_id, business_id)
       VALUES (?, ?, 'x', 'backlog', 'medium', ?, 'default')`,
    )
    .run(id, `task ${id}`, FIXTURE_WORKSPACE);
}

/**
 * Insert a task_activity row exactly as the messages/activities POST routes do.
 * `agentId` must reference a real agents row when non-null (FK enforcement is
 * ON) — the messages route NEVER sets an agent_id for an owner message, so a
 * real agent message here needs a seeded agent to satisfy the FK.
 */
function seedAgent(id: string): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO agents (id, name, role, status, workspace_id)
       VALUES (?, 'Test Agent', 'worker', 'standby', ?)`,
    )
    .run(id, FIXTURE_WORKSPACE);
}

function seedActivity(
  taskId: string,
  id: string,
  activityType: string,
  agentId: string | null = null,
): void {
  if (agentId) seedAgent(agentId);
  getDb()
    .prepare(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(id, taskId, agentId, activityType, `message ${id}`);
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function seedFixtureTask() {
  const TASK = 'task-owner-ids-1';
  seedTask(TASK);
  // Real owner-authored messages — the kind the messages POST writes for
  // sender === 'owner'. These MUST appear in the oracle.
  seedActivity(TASK, 'owner-msg-0001', 'owner_message');
  seedActivity(TASK, 'owner-msg-0042', 'owner_message');
  // An agent-authored message — sender === 'agent'. Must NOT appear.
  seedActivity(TASK, 'agent-msg-9000', 'agent_message', 'agent-1');
  // A non-message activity (status change). Must NOT appear.
  seedActivity(TASK, 'activity-status-1', 'status_changed');
  return TASK;
}

/* ═══════════════════════ FIX-1 CC gate — owner-ids oracle ═══════════════════ */

test('FIX-1: owner-ids route returns the REAL owner message ids only', async () => {
  const TASK = seedFixtureTask();

  const res = await ownerIdsGET(
    new NextRequest(`http://localhost/api/tasks/${TASK}/messages/owner-ids`),
    ctx(TASK),
  );

  assert.equal(res.status, 200, 'oracle must return 200 for an existing task');
  const body = (await res.json()) as unknown;
  assert.ok(Array.isArray(body), 'response must be a JSON array (the engine contract)');

  const ids = body as string[];
  // Both REAL owner message ids must be present.
  assert.ok(ids.includes('owner-msg-0001'), 'a real owner message id must be in the set');
  assert.ok(ids.includes('owner-msg-0042'), 'a real owner message id must be in the set');
  // FORGED ids must be ABSENT — the exact QC gate.
  assert.ok(!ids.includes('e2e-test-002'), 'the forged E2E id must NOT be in the set');
  assert.ok(!ids.includes('agent-msg-9000'), 'an agent message id must NOT be in the set');
  assert.ok(!ids.includes('activity-status-1'), 'a non-message activity id must NOT be in the set');

  // Exactly the two real owner ids — nothing more, nothing less.
  assert.deepEqual(ids, ['owner-msg-0001', 'owner-msg-0042']);
});

test('FIX-1: owner-ids route 404s for a task that does not exist', async () => {
  const res = await ownerIdsGET(
    new NextRequest('http://localhost/api/tasks/no-such-task/messages/owner-ids'),
    ctx('no-such-task'),
  );

  assert.equal(res.status, 404, 'unknown task must be 404 — the engine treats non-200 as DENIED');
});

test('FIX-1: an existing task with NO owner messages returns 200 + [] (never an error)', async () => {
  const TASK = 'task-owner-ids-empty';
  seedTask(TASK);
  // Only an agent message + a status change — zero owner messages. (Unique ids:
  // task_activities.id is a global PRIMARY KEY across the shared test DB.)
  seedActivity(TASK, 'agent-msg-empty-1', 'agent_message', 'agent-1');
  seedActivity(TASK, 'activity-status-empty-1', 'status_changed');

  const res = await ownerIdsGET(
    new NextRequest(`http://localhost/api/tasks/${TASK}/messages/owner-ids`),
    ctx(TASK),
  );

  assert.equal(res.status, 200, 'a task with no owner messages must still be 200');
  const body = (await res.json()) as unknown;
  assert.ok(Array.isArray(body), 'response must be a JSON array');
  assert.deepEqual(body, [], 'empty owner-message set must be an empty array, not a failure');
});

test('FIX-1: listOwnerMessageIds matches the route (one shared implementation)', async () => {
  const TASK = seedFixtureTask();

  const ids = listOwnerMessageIds(TASK);
  assert.deepEqual(ids, ['owner-msg-0001', 'owner-msg-0042']);
  assert.ok(!ids.includes('e2e-test-002'), 'forged id absent at the helper level too');
});

test('FIX-1: listOwnerMessageIds is safe on empty/garbage input (never throws)', () => {
  assert.deepEqual(listOwnerMessageIds(''), []);
  assert.deepEqual(listOwnerMessageIds('   '), []);
  assert.deepEqual(listOwnerMessageIds('task-does-not-exist'), []);
});
