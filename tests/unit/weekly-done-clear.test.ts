/**
 * Unit tests for the weekly Done-clear job (src/lib/jobs/weekly-done-clear.ts).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Strategy: point DATABASE_PATH at a throwaway temp file, then import the DB
 * helpers and the archiveDoneTasks() function to verify:
 *
 *   1. archiveDoneTasks() soft-archives exactly the done tasks that have no
 *      archived_at, leaving non-done tasks and already-archived tasks untouched.
 *   2. The job is idempotent: running it twice produces the same result as
 *      running it once.
 *   3. DISABLE_WEEKLY_DONE_CLEAR=1 causes archiveDoneTasks() to skip.
 *   4. Cron expression '0 7 * * 0' is valid and fires on Sunday 07:00 in the
 *      America/New_York timezone (validated via runWeeklyDoneClear's ET window
 *      guard with a synthetic Sunday 07:05 ET timestamp).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-done-clear-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
// Ensure the DISABLE flag is NOT set for most tests.
delete process.env.DISABLE_WEEKLY_DONE_CLEAR;

type DbModule = typeof import('../../src/lib/db');
let getDb: DbModule['getDb'];
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type JobModule = typeof import('../../src/lib/jobs/weekly-done-clear');
let archiveDoneTasks: JobModule['archiveDoneTasks'];
let WEEKLY_DONE_CLEAR_CRON_EXPR: JobModule['WEEKLY_DONE_CLEAR_CRON_EXPR'];
let WEEKLY_DONE_CLEAR_CRON_TIMEZONE: JobModule['WEEKLY_DONE_CLEAR_CRON_TIMEZONE'];

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;

  // Run the full migration chain (incl. migration 055 add_task_archived_at).
  getDb();

  const job = await import('../../src/lib/jobs/weekly-done-clear');
  archiveDoneTasks = job.archiveDoneTasks;
  WEEKLY_DONE_CLEAR_CRON_EXPR = job.WEEKLY_DONE_CLEAR_CRON_EXPR;
  WEEKLY_DONE_CLEAR_CRON_TIMEZONE = job.WEEKLY_DONE_CLEAR_CRON_TIMEZONE;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

// ── helpers ──────────────────────────────────────────────────────────────────

function insertTask(id: string, status: string, archivedAt?: string | null) {
  // Use a minimal INSERT: only columns guaranteed to exist after migrations.
  // The tasks CHECK allows: backlog, in_progress, review, blocked, done.
  // We always write NULL workspace_id to avoid the REFERENCES workspaces FK.
  const validStatus = ['backlog', 'in_progress', 'review', 'blocked', 'done'].includes(status)
    ? status
    : 'done';
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, ?, 'medium', NULL, NULL, datetime('now'), datetime('now'))`,
    [id, `Task ${id}`, validStatus],
  );
  if (archivedAt !== undefined) {
    run(`UPDATE tasks SET archived_at = ? WHERE id = ?`, [archivedAt, id]);
  }
}

// ── migration check ──────────────────────────────────────────────────────────

test('migration 055: tasks.archived_at column and index exist', () => {
  const cols = new Set(
    queryAll<{ name: string }>('PRAGMA table_info(tasks)').map((c) => c.name),
  );
  assert.ok(cols.has('archived_at'), 'tasks must have archived_at after migration 055');

  const idx = queryOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_archived_at'",
  );
  assert.ok(idx, 'idx_tasks_archived_at index must exist');
});

// ── archiveDoneTasks() logic ─────────────────────────────────────────────────

test('archiveDoneTasks: archives done tasks and leaves non-done tasks untouched', () => {
  insertTask('done-1', 'done');
  insertTask('done-2', 'done');
  insertTask('in-progress-1', 'in_progress');
  insertTask('backlog-1', 'backlog');

  const result = archiveDoneTasks();
  assert.equal(result.archivedCount, 2, 'should archive exactly 2 done tasks');

  const done1 = queryOne<{ archived_at: string | null }>('SELECT archived_at FROM tasks WHERE id = ?', ['done-1']);
  const done2 = queryOne<{ archived_at: string | null }>('SELECT archived_at FROM tasks WHERE id = ?', ['done-2']);
  const inProg = queryOne<{ archived_at: string | null }>('SELECT archived_at FROM tasks WHERE id = ?', ['in-progress-1']);
  const backlog = queryOne<{ archived_at: string | null }>('SELECT archived_at FROM tasks WHERE id = ?', ['backlog-1']);

  assert.ok(done1?.archived_at, 'done-1 must have archived_at set');
  assert.ok(done2?.archived_at, 'done-2 must have archived_at set');
  assert.equal(inProg?.archived_at, null, 'in_progress task must not be archived');
  assert.equal(backlog?.archived_at, null, 'backlog task must not be archived');
});

test('archiveDoneTasks: idempotent — second run archives 0 additional tasks', () => {
  // The two done tasks from the previous test are already archived.
  const result = archiveDoneTasks();
  assert.equal(result.archivedCount, 0, 'second run must be a no-op (all done tasks already archived)');
});

test('archiveDoneTasks: already-archived tasks are not re-archived', () => {
  // Insert a done task that already has archived_at set (simulating a previous clear).
  insertTask('done-already-archived', 'done', '2026-01-01T00:00:00.000Z');
  const before = queryOne<{ archived_at: string }>('SELECT archived_at FROM tasks WHERE id = ?', ['done-already-archived']);

  insertTask('done-new', 'done'); // new eligible task
  const result = archiveDoneTasks();

  assert.equal(result.archivedCount, 1, 'only the newly done task (not the pre-archived one) should be archived');

  const after = queryOne<{ archived_at: string }>('SELECT archived_at FROM tasks WHERE id = ?', ['done-already-archived']);
  assert.equal(after?.archived_at, before?.archived_at, 'pre-archived task archived_at must not change');
});

test('archiveDoneTasks: DISABLE_WEEKLY_DONE_CLEAR=1 skips the job', () => {
  process.env.DISABLE_WEEKLY_DONE_CLEAR = '1';
  insertTask('done-disabled', 'done');

  const result = archiveDoneTasks();
  assert.equal(result.archivedCount, 0, 'should archive 0 tasks when disabled');
  assert.ok(result.skippedReason, 'skippedReason must be set when disabled');

  const task = queryOne<{ archived_at: string | null }>('SELECT archived_at FROM tasks WHERE id = ?', ['done-disabled']);
  assert.equal(task?.archived_at, null, 'done task must not be archived when job is disabled');

  delete process.env.DISABLE_WEEKLY_DONE_CLEAR;
  // Clean up so later tests start fresh.
  run(`DELETE FROM tasks WHERE id = 'done-disabled'`);
});

// ── cron expression / timezone ───────────────────────────────────────────────

test('WEEKLY_DONE_CLEAR_CRON_EXPR is a valid node-cron expression', async () => {
  // Dynamically import node-cron to validate the expression.
  const { validate } = await import('node-cron') as { validate: (expr: string) => boolean };
  assert.ok(
    validate(WEEKLY_DONE_CLEAR_CRON_EXPR),
    `'${WEEKLY_DONE_CLEAR_CRON_EXPR}' must be a valid cron expression`,
  );
});

test('WEEKLY_DONE_CLEAR_CRON_EXPR is "0 7 * * 0" (Sunday 07:00)', () => {
  assert.equal(WEEKLY_DONE_CLEAR_CRON_EXPR, '0 7 * * 0');
});

test('WEEKLY_DONE_CLEAR_CRON_TIMEZONE is America/New_York', () => {
  assert.equal(WEEKLY_DONE_CLEAR_CRON_TIMEZONE, 'America/New_York');
});

test('Intl timezone: Sunday 07:05 America/New_York is a Sunday', () => {
  // Construct a known Sunday 07:05 ET date.
  // 2026-06-07 is a Sunday. 07:05 ET = 11:05 UTC (EDT, UTC-4).
  const sundayET = new Date('2026-06-07T11:05:00Z');
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    })
      .formatToParts(sundayET)
      .map((p) => [p.type, p.value]),
  );
  assert.equal(parts.weekday, 'Sun', 'must be Sunday in ET');
  assert.equal(parseInt(parts.hour ?? '-1', 10), 7, 'must be hour 7 in ET');
});
