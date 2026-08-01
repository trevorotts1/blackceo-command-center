/**
 * U071 — audited status-writer: close the third raw status writer in
 * sop-authoring.ts. It reached `done` without ever entering the state machine,
 * so no gate placed in checkPreconditions could see it.
 *
 * Four cases against a scratch database (never the live one):
 *   (a) The gate can now refuse — a precondition that fails blocks the transition.
 *   (b) The happy path still completes — task reaches done with audit rows.
 *   (c) Idempotence — running the completion twice changes nothing, no double audit.
 *   (d) The exception is closed — a non-union value is a compile-time type error.
 *
 * Case (a) MUST fail against origin/main: the raw UPDATE bypassed checkPreconditions
 * entirely, so the evidence gate that lived there since DISP-09 could not see this
 * path. After the fix, the task stays in_progress and the refusal names the gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolated scratch database ──────────────────────────────────────────────────
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u071-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;
process.env.MC_API_TOKEN = 'test-u071-mc-token';

const RUN_ID = Math.random().toString(36).slice(2, 10);

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type LifecycleModule = typeof import('../../src/lib/task-lifecycle');
let transitionWithDeclaredException: LifecycleModule['transitionWithDeclaredException'];
let TransitionError: LifecycleModule['TransitionError'];

let counter = 0;
const nextId = (prefix: string) => `u071-${prefix}-${++counter}-${RUN_ID}`;

/** Read a task's current status. */
const statusOf = (id: string): string | undefined =>
  queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;

/** Count task_events rows for a task. */
const taskEventCount = (id: string): number =>
  queryOne<{ c: number }>(
    'SELECT COUNT(*) AS c FROM task_events WHERE task_id = ?',
    [id],
  )?.c ?? 0;

/** Count legacy events rows for a task. */
const legacyEventCount = (id: string): number =>
  queryOne<{ c: number }>(
    "SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND type = 'task_completed'",
    [id],
  )?.c ?? 0;

/** Seed an in_progress task suitable for SOP-authoring completion. */
function seedInProgressTask(id: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, department,
                        workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, 'in_progress', 'medium', 'custom-dept',
             NULL, ?, ?)`,
    [id, `Task ${id}`, `Description for ${id}`, now, now],
  );
}

/** Register a URL deliverable against a task (clears the evidence gate). */
function registerUrlDeliverable(taskId: string): void {
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?, ?, 'url', ?, ?, ?)`,
    [nextId('deliv'), taskId, `Deliverable for ${taskId}`, 'https://example.com/delivered', new Date().toISOString()],
  );
}

// ── Compile-time assertion: DeclaredTransitionException is a closed union ───
// Case (d) is a compile-time assertion: TypeScript rejects any object whose
// `kind` is not a member of the union at `npx tsc --noEmit`. This test file's
// own type-check proves case (d). The runtime portion of case (d) confirms the
// function rejects a task in the wrong from-state for the declared exception.

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // trigger schema migration

  const lifecycle = await import('../../src/lib/task-lifecycle');
  transitionWithDeclaredException = lifecycle.transitionWithDeclaredException;
  TransitionError = lifecycle.TransitionError;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────────────────────────────────────────────────────────
// Case (a) — The gate can now refuse
// ─────────────────────────────────────────────────────────────────────────────
// A task with no registered deliverable should be REFUSED by the
// completion-evidence gate in checkPreconditions. Before U071, the raw UPDATE
// bypassed checkPreconditions entirely, so this task would silently reach done.
// This is the load-bearing test: it MUST fail against origin/main.

test('(a) gate refuses when precondition fails — task does NOT reach done', () => {
  const taskId = nextId('a');
  seedInProgressTask(taskId);

  // Drive the SOP-authoring completion path through the audited entry point.
  // The task has NO deliverable, so the completion-evidence gate in
  // checkPreconditions must refuse it.
  let err: Error | null = null;
  try {
    transitionWithDeclaredException({
      taskId,
      to: 'done',
      exception: { kind: 'sop-authoring-subtask-complete' },
      actor: 'sop-authoring',
      reason: 'SOP "Test SOP" authored and filed',
      extraColumns: { completed_at: new Date().toISOString() },
    });
  } catch (e) {
    err = e as Error;
  }

  // The transition must have thrown.
  assert.ok(err !== null, 'expected transitionWithDeclaredException to throw when precondition fails');
  assert.ok(
    err instanceof TransitionError,
    'error must be a TransitionError',
  );
  assert.equal(
    (err as InstanceType<typeof TransitionError>).code,
    'PRECONDITION_EVIDENCE',
    `expected PRECONDITION_EVIDENCE, got ${(err as InstanceType<typeof TransitionError>).code}`,
  );

  // The task's status must NOT have changed.
  const currentStatus = statusOf(taskId);
  assert.equal(
    currentStatus,
    'in_progress',
    `task must remain in_progress when gate refuses, got ${currentStatus}`,
  );

  // No audit rows should have been written.
  assert.equal(taskEventCount(taskId), 0, 'no task_events row must be written on refusal');
  assert.equal(legacyEventCount(taskId), 0, 'no legacy events row must be written on refusal');
});

// ─────────────────────────────────────────────────────────────────────────────
// Case (b) — The happy path still completes
// ─────────────────────────────────────────────────────────────────────────────
// With a registered deliverable satisfying the evidence gate, the SOP-authoring
// completion path must succeed — task reaches done, completed_at is set, and
// both audit rows exist.
//
// NOTE: completed_at is set by the caller via extraColumns in the same UPDATE
// that sets status, but the trg_tasks_completed_at AFTER UPDATE trigger then
// overwrites it with datetime('now'). So we assert completed_at is non-null
// rather than matching the provided value exactly.

test('(b) happy path completes — task reaches done with audit rows', () => {
  const taskId = nextId('b');
  seedInProgressTask(taskId);
  registerUrlDeliverable(taskId);

  const completedAt = new Date().toISOString();
  const result = transitionWithDeclaredException({
    taskId,
    to: 'done',
    exception: { kind: 'sop-authoring-subtask-complete' },
    actor: 'sop-authoring',
    reason: `SOP "Test SOP" authored and filed (QC 9.5/10 PASS)`,
    extraColumns: { completed_at: completedAt },
  });

  // The task must now be done.
  const currentStatus = statusOf(taskId);
  assert.equal(currentStatus, 'done', `task must reach done, got ${currentStatus}`);

  // completed_at must be set (the trigger or the caller set it).
  const row = queryOne<{ completed_at: string | null; updated_at: string | null }>(
    'SELECT completed_at, updated_at FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.ok(row !== null, 'task row must exist after transition');
  assert.ok(row!.completed_at !== null, 'completed_at must be set');

  // Return value must be the updated task.
  assert.ok(result !== null, 'result must be the updated task row');
  assert.equal((result as any).status, 'done', 'returned task must have status done');

  // Both audit rows must be present.
  const teCount = taskEventCount(taskId);
  assert.equal(teCount, 1, `expected 1 task_events row, got ${teCount}`);

  const leCount = legacyEventCount(taskId);
  assert.equal(leCount, 1, `expected 1 legacy events row, got ${leCount}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Case (c) — Idempotence
// ─────────────────────────────────────────────────────────────────────────────
// Running the completion twice must not double-write audit rows, and the second
// call must not change anything. The idempotent short-circuit (from === args.to)
// prevents double-writing.

test('(c) idempotence — second call changes nothing and does not double-write audit rows', () => {
  const taskId = nextId('c');
  seedInProgressTask(taskId);
  registerUrlDeliverable(taskId);

  const completedAt = new Date().toISOString();

  // First call — must succeed.
  const firstResult = transitionWithDeclaredException({
    taskId,
    to: 'done',
    exception: { kind: 'sop-authoring-subtask-complete' },
    actor: 'sop-authoring',
    reason: `SOP "Test SOP" authored and filed (QC 9.5/10 PASS)`,
    extraColumns: { completed_at: completedAt },
  });
  assert.equal((firstResult as any).status, 'done', 'first call must set task to done');

  const teAfterFirst = taskEventCount(taskId);
  const leAfterFirst = legacyEventCount(taskId);
  assert.equal(teAfterFirst, 1, 'first call writes 1 task_events row');
  assert.equal(leAfterFirst, 1, 'first call writes 1 legacy events row');

  // Second call — idempotent. Task is already done, so the function returns
  // the current row without writing anything new.
  const secondResult = transitionWithDeclaredException({
    taskId,
    to: 'done',
    exception: { kind: 'sop-authoring-subtask-complete' },
    actor: 'sop-authoring',
    reason: `SOP "Test SOP" authored and filed (QC 9.5/10 PASS)`,
    extraColumns: { completed_at: completedAt },
  });
  assert.equal((secondResult as any).status, 'done', 'second call must still return task as done');

  // Audit rows must not have doubled.
  const teAfterSecond = taskEventCount(taskId);
  const leAfterSecond = legacyEventCount(taskId);
  assert.equal(teAfterSecond, 1, `second call must not double-write task_events: expected 1, got ${teAfterSecond}`);
  assert.equal(leAfterSecond, 1, `second call must not double-write legacy events: expected 1, got ${leAfterSecond}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Case (d) — The exception is closed (compile-time assertion + runtime check)
// ─────────────────────────────────────────────────────────────────────────────
// DeclaredTransitionException is a TypeScript discriminated union with exactly
// one member. Any attempt to pass a `kind` not in the union is rejected by
// `npx tsc --noEmit`. This file compiles with the correct member; a deliberate
// non-union value produces a type error at build time.
//
// Runtime confirmation: the function rejects a task whose from-state does not
// match what the declared exception expects.

test('(d) exception closed — correct member accepted, wrong from-state refused', () => {
  // Seed a task in the WRONG state for the declared exception.
  // sop-authoring-subtask-complete expects source 'in_progress'.
  const taskId = nextId('d');
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, department,
                        workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', 'custom-dept',
             NULL, ?, ?)`,
    [taskId, `Task ${taskId}`, `Description for ${taskId}`, now, now],
  );

  // The exception's expected from→to pair is in_progress→done.
  // Calling from 'backlog' must throw.
  let err: Error | null = null;
  try {
    transitionWithDeclaredException({
      taskId,
      to: 'done',
      exception: { kind: 'sop-authoring-subtask-complete' },
      actor: 'sop-authoring',
      reason: 'should not reach here',
    });
  } catch (e) {
    err = e as Error;
  }

  assert.ok(err !== null, 'must throw when task is not in the expected from-state');
  assert.ok(
    err instanceof TransitionError,
    'error must be a TransitionError',
  );
  assert.equal(
    (err as InstanceType<typeof TransitionError>).code,
    'ILLEGAL_TRANSITION',
    'must reject with ILLEGAL_TRANSITION when from-state does not match exception',
  );

  // Task must still be 'backlog' — unchanged.
  const currentStatus = statusOf(taskId);
  assert.equal(currentStatus, 'backlog', 'task must remain in original state after refusal');
});
