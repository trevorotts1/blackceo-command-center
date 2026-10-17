/**
 * council-dispatch-hold.test.ts — CWE-050 item 5: the manually
 * assigned dispatch edge (CWE-035/CWE-036 remainder).
 *
 * Council action-plan tasks are created held (tasks.dispatch_hold
 * = 1, routing_reason 'council_plan_assembling') and only CWE-036's
 * execution guard may clear the hold. The board sweeps exclude
 * held tasks from their candidate queries, but a held task handed
 * an agent BY HAND reaches autoDispatchTask directly. Before
 * CWE-050, nothing on that path checked the hold, so a manual
 * assignment could execute a council task that had never passed
 * the release chain (no exact plan approval check, no active run
 * grant, no dependency or condition verification).
 *
 * The fix is the dispatch_hold guard inside autoDispatchTask
 * itself (GUARD 3b in src/lib/task-dispatcher.ts) rather than
 * registering 'council' as an engine-owned source: a RELEASED
 * council task must re-enter ordinary intake and dispatch
 * normally, which source registration would prevent forever.
 *
 * This test proves both halves:
 *   1. A held council task with an agent assigned by hand is
 *      refused at the hold guard; no execution row, no activity
 *      row, no dispatch attempt, the task is untouched.
 *   2. Control: once the hold is cleared the way the guard clears
 *      it, the same task passes the hold guard (the refusal reason
 *      changes — dispatch proceeds to its next stage).
 *
 * Uses its own temp DB (the auto-dispatch-routing.test.ts pattern);
 * deliberately NOT the shared council _isolated-db, because the
 * dispatcher reads the host task tables directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-council-hold-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];
let autoDispatchTask: typeof import('../../src/lib/task-dispatcher').autoDispatchTask;

test.before(async () => {
  const dbModule: DbModule = await import('../../src/lib/db');
  run = dbModule.run;
  queryOne = dbModule.queryOne;
  queryAll = dbModule.queryAll;
  closeDb = dbModule.closeDb;
  getDb = dbModule.getDb;
  getDb();
  const td = await import('../../src/lib/task-dispatcher');
  autoDispatchTask = td.autoDispatchTask;

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Test Company', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('ws-ops', 'Operations', 'operations', 'Ops dept', 'x', 'default', 10, ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO agents
       (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
        specialist_type, created_at, updated_at)
     VALUES ('agent-ops', 'Ops Lead', 'Ops Lead', 'Operations specialist',
             'x', 'standby', 0, 'ws-ops', 'permanent', ?, ?)`,
    [now, now],
  );
  // A council plan task exactly as CWE-036's assembly creates it,
  // then handed an agent by hand (the edge being closed).
  run(
    `INSERT INTO tasks
       (id, title, status, priority, workspace_id, assigned_agent_id, source,
        routing_reason, dispatch_hold, qc_reroute_attempts, created_at, updated_at)
     VALUES ('task-council-held', 'Council plan task', 'backlog', 'medium', 'ws-ops',
             'agent-ops', 'council', 'council_plan_assembling', 1, 0, ?, ?)`,
    [now, now],
  );
});

test.after(() => {
  try { closeDb(); } catch { /* ok */ }
  try { fs.unlinkSync(TMP_DB); } catch { /* ok */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ok */ }
});

test('a held council task handed an agent by hand cannot execute', async () => {
  const result = await autoDispatchTask('task-council-held', 'test-manual-assign');
  assert.equal(result.status, 'held');
  assert.equal((result as { reason?: string }).reason, 'dispatch_precondition');

  const executions = queryAll<{ n: number }>(
    'SELECT COUNT(*) AS n FROM task_executions WHERE task_id = ?',
    ['task-council-held'],
  );
  assert.equal(executions[0].n, 0, 'no execution was started');
  const activities = queryAll<{ n: number }>(
    'SELECT COUNT(*) AS n FROM task_activities WHERE task_id = ?',
    ['task-council-held'],
  );
  assert.equal(activities[0].n, 0, 'no dispatch activity was recorded');
  const task = queryOne<{ status: string; dispatch_hold: number; dispatch_attempts: number }>(
    'SELECT status, dispatch_hold, dispatch_attempts FROM tasks WHERE id = ?',
    ['task-council-held'],
  );
  assert.equal(task?.status, 'backlog', 'the task state is untouched');
  assert.equal(task?.dispatch_hold, 1, 'the hold itself is untouched');
  assert.equal(task?.dispatch_attempts, 0, 'the dispatcher never even attempted the task');
});

test('control: clearing the hold the way the guard does lets the same task past the hold guard', async () => {
  // Exactly CWE-036's release write (action-execution.ts): hold
  // cleared and routing_reason nulled, under the source+reason CAS.
  run(
    `UPDATE tasks SET dispatch_hold = 0, routing_reason = NULL
      WHERE id = ? AND source = 'council' AND dispatch_hold = 1
        AND routing_reason = 'council_plan_assembling'`,
    ['task-council-held'],
  );
  // Train integration calibration (mainline PERSONA-RACE stage): the
  // dispatcher on current main defers a triad-incomplete card younger
  // than PERSONA_PIN_GRACE_SECONDS (default 120) with no attempt
  // counted, while its persona pin may still be in flight. That stage
  // did not exist when this control was calibrated, and the fixture
  // card is seconds old, so age the card past the grace window; the
  // control then measures the same thing it always did: the released
  // card travels past the hold guard into the pipeline and stops at
  // the triad completeness gate, which records attempt 1.
  run(
    `UPDATE tasks SET created_at = ? WHERE id = ?`,
    [new Date(Date.now() - 10 * 60 * 1000).toISOString(), 'task-council-held'],
  );
  await autoDispatchTask('task-council-held', 'test-after-release');
  // Calibration (observed on this fixture, 2026-10-14): the
  // dispatcher's later guards share the held/dispatch_precondition
  // result shape, so the result alone cannot show which guard
  // stopped the task. The distinguishing observable is the dispatch
  // attempt bookkeeping: a task refused at the hold guard records
  // NO attempt (see the test above); a task that passes the hold
  // guard travels into the pipeline and its first downstream stop
  // (here the triad completeness gate — this fixture task has no
  // description, SOP, or persona) records attempt 1 with a backoff.
  const task = queryOne<{ dispatch_attempts: number; next_dispatch_eligible_at: string | null }>(
    'SELECT dispatch_attempts, next_dispatch_eligible_at FROM tasks WHERE id = ?',
    ['task-council-held'],
  );
  assert.equal(task?.dispatch_attempts, 1, 'the released task entered the dispatch pipeline');
  assert.ok(task?.next_dispatch_eligible_at, 'the downstream gate recorded its backoff');
});
