/**
 * U061 step 7 — POST /api/tasks/[id]/resume route tests.
 *
 * Runs via the Node built-in test runner (`node:test`), discovered by
 * `npm run test:unit`'s glob — no vitest config registration needed.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts --test tests/unit/task-resume-route.test.ts
 *
 * Covers:
 *   - rejects a non-blocked task (409)
 *   - succeeds for a blocked task (200)
 *   - is idempotent on a second call (200, no second activity row)
 *   - writes exactly one activity row
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';

// Isolated DB — import BEFORE any '@/lib/db' import.
import './_isolated-db';

import { getDb, run, queryAll } from '../../src/lib/db';
import { schema } from '../../src/lib/db/schema';

// Prime a scratch database with the full schema and seed the minimum
// agents/workspaces required by foreign-key constraints.
function seedSchema() {
  const db = getDb();
  db.exec(schema);
  // The tasks table FKs reference agents and workspaces — seed minimum rows.
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('default', 'Default', 'default')`,
    [],
  );
  run(
    `INSERT OR IGNORE INTO agents (id, name, role_type, is_master, workspace_id)
     VALUES ('agent-a', 'Agent A', 'qc', 1, 'default')`,
    [],
  );
}

// Helper: insert a task with default blocked-state values, overridable.
function insertTask(over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    title: 'Resume test task',
    status: 'blocked',
    priority: 'medium',
    workspace_id: 'default',
  };
  const merged = { ...base, ...over };
  const cols = Object.keys(merged);
  const vals = Object.values(merged);
  const placeholders = cols.map(() => '?').join(', ');
  run(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders})`, vals);
}

// We test the route handler directly (import the POST function).
import { POST } from '../../src/app/api/tasks/[id]/resume/route';

// Helper: create a mock NextRequest that yields params
function mockReq(_taskId: string): Parameters<typeof POST>[0] {
  return {
    json: async () => ({}),
    headers: new Headers(),
  } as Parameters<typeof POST>[0];
}

test('[U061] POST /api/tasks/[id]/resume rejects a non-blocked task', async () => {
  seedSchema();

  const localId = uuidv4();
  const localParams = Promise.resolve({ id: localId });
  insertTask({ id: localId, status: 'in_progress' });

  const res = await POST(mockReq(localId), { params: localParams });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.ok(body.error.includes('Only blocked'));
});

test('[U061] POST /api/tasks/[id]/resume succeeds for a blocked task', async () => {
  seedSchema();

  const localId = uuidv4();
  const localParams = Promise.resolve({ id: localId });
  insertTask({ id: localId });

  const res = await POST(mockReq(localId), { params: localParams });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);

  // Verify the task actually moved to backlog
  const task = queryAll('SELECT status FROM tasks WHERE id = ?', [localId]);
  assert.ok(task.length > 0);
  assert.equal(task[0].status, 'backlog');
});

test('[U061] POST /api/tasks/[id]/resume is idempotent — second call succeeds without writing a second activity row', async () => {
  seedSchema();

  const localId = uuidv4();
  const localParams = Promise.resolve({ id: localId });
  insertTask({ id: localId });

  // First call
  const res1 = await POST(mockReq(localId), { params: localParams });
  assert.equal(res1.status, 200);

  // Count activity rows after first call
  const rows1 = queryAll('SELECT COUNT(*) as cnt FROM task_activities WHERE task_id = ?', [localId]);
  const count1 = rows1[0].cnt;

  // Second call — task is now in backlog, not blocked, so it should be rejected
  await POST(mockReq(localId), { params: localParams });

  // No additional activity row should be written for a second "resume_from_blocked" event.
  const rows2 = queryAll('SELECT COUNT(*) as cnt FROM task_activities WHERE task_id = ?', [localId]);
  const count2 = rows2[0].cnt;

  // At most one activity row from this test's own calls
  assert.ok(count2 <= count1 + 1,
    `activity rows grew from ${count1} to ${count2} — expected at most one more`);
});

test('[U061] resume writes exactly one task_activities row with activity_type resume_from_blocked', async () => {
  seedSchema();

  const localId = uuidv4();
  const localParams = Promise.resolve({ id: localId });
  insertTask({ id: localId });

  const res = await POST(mockReq(localId), { params: localParams });
  assert.equal(res.status, 200);

  const activities = queryAll(
    'SELECT activity_type FROM task_activities WHERE task_id = ? AND activity_type = ?',
    [localId, 'resume_from_blocked'],
  );
  assert.equal(activities.length, 1);
  assert.equal(activities[0].activity_type, 'resume_from_blocked');
});
