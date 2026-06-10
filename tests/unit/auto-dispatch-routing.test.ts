/**
 * Unit tests for auto-dispatch after routing (v4.14.0).
 *
 * Verifies:
 *   1. autoDispatchTask is exported as a function from task-dispatcher.
 *   2. Master/CEO agents (is_master=1) are NOT auto-dispatched (guard fires
 *      before any OpenClaw connection attempt — status stays in backlog).
 *   3. Tasks already in_progress/review/done/blocked/archived are skipped.
 *   4. QC loop cap (qc_reroute_attempts > QC_MAX_REROUTES) blocks dispatch.
 *   5. autoDispatchTask skips tasks with no assigned_agent_id.
 *   6. autoDispatchTask handles non-existent task IDs without throwing.
 *   7. Import is stable (no circular dependency crash).
 *
 * Uses an isolated temp DB. Forces heuristic path (no API keys).
 * All guards fire before any OpenClaw gateway connection is attempted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-auto-dispatch-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// No real API keys in unit tests.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

// Use a low QC cap for testing.
process.env.QC_MAX_REROUTES = '2';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];
let queryAll: DbModule['queryAll'];

type TaskDispatcherModule = typeof import('../../src/lib/task-dispatcher');
let autoDispatchTask: TaskDispatcherModule['autoDispatchTask'];

type QCScorerModule = typeof import('../../src/lib/qc-scorer');
let QC_MAX_REROUTES_val: number;

// ── Setup ────────────────────────────────────────────────────────────────────

test.before(async () => {
  const db: DbModule = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  getDb = db.getDb;
  queryAll = db.queryAll;

  // Trigger full migration chain.
  getDb();

  const td: TaskDispatcherModule = await import('../../src/lib/task-dispatcher');
  autoDispatchTask = td.autoDispatchTask;

  const qc: QCScorerModule = await import('../../src/lib/qc-scorer');
  QC_MAX_REROUTES_val = qc.QC_MAX_REROUTES;

  const now = new Date().toISOString();

  // Seed the default company row (required by workspaces FK).
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Test Company', 'default', '{}', ?, ?)`,
    [now, now],
  );

  // Seed Graphics workspace
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('ws-graphics', 'Graphics', 'graphics', 'Graphics dept', '🎨', 'default', 10, ?, ?)`,
    [now, now],
  );

  // Seed CEO/master-orchestrator workspace
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('ws-ceo', 'Master Orchestrator', 'master-orchestrator', 'CEO workspace', '🎯', 'default', 0, ?, ?)`,
    [now, now],
  );

  // Check whether role_type column exists (migration 060).
  const cols = queryAll<{ name: string }>('PRAGMA table_info(agents)', []);
  const hasRoleType = cols.some((c) => c.name === 'role_type');

  // Seed specialist agent (non-master)
  if (hasRoleType) {
    run(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
          specialist_type, role_type, created_at, updated_at)
       VALUES ('agent-graphics', 'Graphics Lead', 'Graphics Lead', 'Graphics specialist',
               '🎨', 'standby', 0, 'ws-graphics', 'permanent', null, ?, ?)`,
      [now, now],
    );
    // Seed master/CEO agent
    run(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
          specialist_type, role_type, created_at, updated_at)
       VALUES ('agent-ceo', 'Curtis', 'CEO', 'Master orchestrator', '🤖', 'standby', 1, 'ws-ceo',
               'permanent', null, ?, ?)`,
      [now, now],
    );
  } else {
    run(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
          specialist_type, created_at, updated_at)
       VALUES ('agent-graphics', 'Graphics Lead', 'Graphics Lead', 'Graphics specialist',
               '🎨', 'standby', 0, 'ws-graphics', 'permanent', ?, ?)`,
      [now, now],
    );
    run(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
          specialist_type, created_at, updated_at)
       VALUES ('agent-ceo', 'Curtis', 'CEO', 'Master orchestrator', '🤖', 'standby', 1, 'ws-ceo',
               'permanent', ?, ?)`,
      [now, now],
    );
  }
});

test.after(() => {
  try { closeDb(); } catch { /* ok */ }
  try { fs.unlinkSync(TMP_DB); } catch { /* ok */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ok */ }
  delete process.env.QC_MAX_REROUTES;
});

// ── Helper ───────────────────────────────────────────────────────────────────

function seedTask(
  id: string,
  title: string,
  status: string,
  workspaceId: string,
  assignedAgentId: string | null,
  qcRerouteAttempts = 0,
) {
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO tasks (id, title, status, priority, workspace_id, assigned_agent_id, qc_reroute_attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'medium', ?, ?, ?, ?, ?)`,
    [id, title, status, workspaceId, assignedAgentId, qcRerouteAttempts, now, now],
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('autoDispatchTask: exported as a function', () => {
  assert.strictEqual(
    typeof autoDispatchTask,
    'function',
    'autoDispatchTask must be a function',
  );
});

test('autoDispatchTask: handles non-existent task ID without throwing', async () => {
  await assert.doesNotReject(
    () => autoDispatchTask('does-not-exist-00000000', 'test'),
    'must not throw for unknown taskId',
  );
});

test('autoDispatchTask: skips task with no assigned_agent_id', async () => {
  seedTask('task-no-agent', 'Task with no agent', 'backlog', 'ws-graphics', null);
  await assert.doesNotReject(() => autoDispatchTask('task-no-agent', 'test'));
  const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', ['task-no-agent']);
  assert.strictEqual(row?.status, 'backlog', 'task without agent must remain in backlog');
});

test('autoDispatchTask: skips master/CEO agent (is_master=1)', async () => {
  // Guard fires BEFORE OpenClaw connection — task must remain in backlog.
  seedTask('task-ceo', 'CEO task', 'backlog', 'ws-ceo', 'agent-ceo');
  await autoDispatchTask('task-ceo', 'test');
  const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', ['task-ceo']);
  assert.strictEqual(row?.status, 'backlog', 'CEO-assigned task must not be auto-dispatched');
});

test('autoDispatchTask: skips task already in_progress', async () => {
  seedTask('task-inprog', 'Already running', 'in_progress', 'ws-graphics', 'agent-graphics');
  await assert.doesNotReject(() => autoDispatchTask('task-inprog', 'test'));
  const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', ['task-inprog']);
  assert.strictEqual(row?.status, 'in_progress', 'in_progress status must not change');
});

test('autoDispatchTask: skips review/done/blocked terminal statuses', async () => {
  // Note: 'archived' is not a valid tasks.status CHECK value (tasks use archived_at column).
  // The SKIP_STATUSES set also covers 'archived' for defensive guard but we only
  // test DB-valid statuses here.
  for (const status of ['review', 'done', 'blocked']) {
    const id = `task-skip-${status}`;
    seedTask(id, `Task in ${status}`, status, 'ws-graphics', 'agent-graphics');
    await autoDispatchTask(id, 'test');
    const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id]);
    assert.strictEqual(row?.status, status, `Task in "${status}" must remain unchanged`);
  }
});

test('autoDispatchTask: skips task at QC loop cap', async () => {
  const cap = QC_MAX_REROUTES_val + 1; // exceeds cap
  seedTask('task-qc-cap', 'QC-capped task', 'backlog', 'ws-graphics', 'agent-graphics', cap);
  await autoDispatchTask('task-qc-cap', 'test');
  const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', ['task-qc-cap']);
  assert.strictEqual(row?.status, 'backlog', 'QC-capped task must remain in backlog');
});

test('QC_MAX_REROUTES: is a positive number', () => {
  assert.strictEqual(typeof QC_MAX_REROUTES_val, 'number');
  assert.ok(QC_MAX_REROUTES_val >= 1, 'must be at least 1');
});

test('task-dispatcher: re-import is stable (no circular dep crash)', async () => {
  const mod = await import('../../src/lib/task-dispatcher');
  assert.strictEqual(typeof mod.autoDispatchTask, 'function');
});
