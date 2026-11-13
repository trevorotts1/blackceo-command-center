/**
 * db-retention-status-snapshots.test.ts — the fifth retention table, the
 * starvation fault, and the honest failure (U-14, findings CC-006/CC-057).
 *
 * Coverage:
 *   1. `system_status_snapshots` is pruned on `probed_at`: an 8-day-old row is
 *      deleted, a 6-day-old row is kept, a row with a NULL probed_at is kept,
 *      and SYSTEM_STATUS_SNAPSHOTS_RETENTION_DAYS=30 keeps an 8-day-old row.
 *   2. STARVATION (fails before the fix): with a 1-row batch size and a 1-second
 *      budget, one huge backlog in `presentation_stage_timings` must NOT stop
 *      the other four tables from being pruned in the same run.
 *   3. FAILED DELETE (fails before the fix): a table whose DELETE throws is
 *      reported, every other table is still pruned, and the run rejects with
 *      `db_retention_partial_failure` instead of reading as success.
 *
 * Run: node --import tsx --import ./tests/setup/no-owner-telegram.ts --test tests/unit/db-retention-status-snapshots.test.ts
 */

delete process.env.DISABLE_DB_RETENTION;
delete process.env.STAGE_TIMINGS_RETENTION_DAYS;
delete process.env.SSE_EVENT_LOG_RETENTION_DAYS;
delete process.env.SYSTEM_STATUS_SNAPSHOTS_RETENTION_DAYS;
delete process.env.EVENTS_RETENTION_DAYS;
delete process.env.TASK_ACTIVITIES_RETENTION_DAYS;
delete process.env.DB_RETENTION_BATCH_SIZE;
delete process.env.DB_RETENTION_BUDGET_SECONDS;

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { runDbRetention } from '../../src/lib/jobs/db-retention';

const db = getDb(); // apply the full migration chain

// The shipped table declares `probed_at TEXT NOT NULL`, so a NULL row cannot
// exist through normal writes — yet the prune predicate must provably leave one
// alone. Replace the table with a nullable copy in this throwaway database so
// the NULL case is testable.
db.exec(`
  DROP TABLE IF EXISTS system_status_snapshots;
  CREATE TABLE system_status_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    probed_at TEXT,
    component TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('live', 'working', 'busy', 'degraded', 'offline', 'unknown', 'ok', 'down')),
    latency_ms INTEGER,
    error TEXT,
    metadata TEXT DEFAULT '{}'
  );
  CREATE INDEX idx_system_status_component_probed ON system_status_snapshots(component, probed_at DESC);
  CREATE INDEX idx_system_status_probed_at ON system_status_snapshots(probed_at DESC);
`);

const WS_ID = `ws-${uuidv4()}`;
run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 911)', [
  WS_ID,
  'Retention Snapshots WS',
  `retention-snap-${uuidv4().slice(0, 8)}`,
]);

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Clear only the five pruned tables. `tasks` is left alone (other tables
 *  foreign-key into it); each test makes its own task ids. */
function clearFixtures(): void {
  run('DELETE FROM task_activities');
  run('DELETE FROM events');
  run('DELETE FROM sse_event_log');
  run('DELETE FROM system_status_snapshots');
  run('DELETE FROM presentation_stage_timings');
}

function exists(table: string, id: string | number): boolean {
  return (queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, [id])?.n ?? 0) > 0;
}

/** A DONE card — the only kind whose activity rows are prunable. */
function makeDoneTask(): string {
  const id = `task-${uuidv4()}`;
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, archived_at, created_at, updated_at)
     VALUES (?, 'retention snapshots', 'done', ?, NULL, ?, ?)`,
    [id, WS_ID, daysAgoIso(200), daysAgoIso(200)],
  );
  return id;
}

/** task_id NULL is board-wide and prunable; age alone decides. */
function seedEvent(ageDays: number): string {
  const id = uuidv4();
  run('INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, NULL, ?, ?)', [
    id,
    'retention_fixture',
    'fixture',
    daysAgoIso(ageDays),
  ]);
  return id;
}

function seedActivity(taskId: string, ageDays: number): string {
  const id = uuidv4();
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (?, ?, 'comment', 'fixture', ?)`,
    [id, taskId, daysAgoIso(ageDays)],
  );
  return id;
}

function seedStageTiming(ageDays: number): number {
  const info = run(
    `INSERT INTO presentation_stage_timings (run_id, event, payload, created_at)
     VALUES (?, 'phase_exit', '{}', ?)`,
    [`run-${uuidv4().slice(0, 8)}`, daysAgoIso(ageDays)],
  );
  return Number(info.lastInsertRowid);
}

function seedSseRow(ageDays: number): number {
  const info = run(
    `INSERT INTO sse_event_log (origin, event_type, payload, created_at)
     VALUES ('test', 'fixture', '{}', ?)`,
    [daysAgoIso(ageDays)],
  );
  return Number(info.lastInsertRowid);
}

/** `null` here means a genuinely NULL probed_at, which must never be deleted. */
function seedStatusRow(ageDays: number | null): number {
  const info = run(
    `INSERT INTO system_status_snapshots (probed_at, component, status, metadata)
     VALUES (?, ?, 'ok', '{}')`,
    [ageDays === null ? null : daysAgoIso(ageDays), `comp-${uuidv4().slice(0, 8)}`],
  );
  return Number(info.lastInsertRowid);
}

function lastRetentionEventMessage(): string {
  return (
    queryOne<{ message: string }>(
      `SELECT message FROM events WHERE type = 'db_retention_ran' AND task_id IS NULL
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [],
    )?.message ?? ''
  );
}

// ── 1. age rules for the fifth table ─────────────────────────────────────────

test('system_status_snapshots: 8-day rows go, 6-day and null-probed_at rows stay, 30-day override keeps 8 days', async () => {
  clearFixtures();

  const old = seedStatusRow(8); // > 7d default
  const fresh = seedStatusRow(6); // < 7d default
  const nullProbed = seedStatusRow(null);

  const result = await runDbRetention();

  assert.equal(result.deleted.system_status_snapshots, 1, 'exactly the 8-day row is deleted');
  assert.equal(exists('system_status_snapshots', old), false, 'the 8-day row is gone');
  assert.equal(exists('system_status_snapshots', fresh), true, 'the 6-day row survives the 7-day window');
  assert.equal(exists('system_status_snapshots', nullProbed), true, 'a NULL probed_at row is never deleted');
  assert.match(
    lastRetentionEventMessage(),
    /status_snapshots=1/,
    'the summary line carries the fifth table count',
  );

  // Env override widens the window; nothing may be deleted.
  clearFixtures();
  const eightDays = seedStatusRow(8);
  process.env.SYSTEM_STATUS_SNAPSHOTS_RETENTION_DAYS = '30';
  let second;
  try {
    second = await runDbRetention();
  } finally {
    delete process.env.SYSTEM_STATUS_SNAPSHOTS_RETENTION_DAYS;
  }
  assert.equal(second.deleted.system_status_snapshots, 0, 'a 30-day window deletes nothing here');
  assert.equal(exists('system_status_snapshots', eightDays), true, 'the 8-day row survives a 30-day window');
});

// ── 2. starvation: one huge backlog must not block the other tables ─────────

test('one huge backlog does not starve the other four tables of the same run', async () => {
  clearFixtures();
  const doneTask = makeDoneTask();

  // 50,000 old stage timings with a 1-row batch and a 1-second TOTAL budget.
  const stmt = db.prepare(
    `INSERT INTO presentation_stage_timings (run_id, event, payload, created_at)
     VALUES ('bulk', 'phase_exit', '{}', ?)`,
  );
  const oldIso = daysAgoIso(40);
  const insertMany = db.transaction((n: number) => {
    for (let i = 0; i < n; i += 1) stmt.run(oldIso);
  });
  insertMany(50_000);

  // One old row in each of the other four tables.
  const statusRow = seedStatusRow(30);
  const sseRow = seedSseRow(30);
  const eventRow = seedEvent(365);
  const activityRow = seedActivity(doneTask, 365);

  process.env.DB_RETENTION_BATCH_SIZE = '1';
  process.env.DB_RETENTION_BUDGET_SECONDS = '1';
  let result;
  try {
    result = await runDbRetention();
  } finally {
    delete process.env.DB_RETENTION_BATCH_SIZE;
    delete process.env.DB_RETENTION_BUDGET_SECONDS;
  }

  assert.equal(result.budgetExhausted, true, 'the backlog cannot finish inside a 1-second budget');
  assert.equal(result.deleted.system_status_snapshots, 1, 'status snapshots were still pruned');
  assert.equal(result.deleted.sse_event_log, 1, 'sse_event_log was still pruned');
  assert.equal(result.deleted.events, 1, 'events was still pruned');
  assert.equal(result.deleted.task_activities, 1, 'task_activities was still pruned');

  assert.equal(exists('system_status_snapshots', statusRow), false, 'the status snapshot row is gone');
  assert.equal(exists('sse_event_log', sseRow), false, 'the sse row is gone');
  assert.equal(exists('events', eventRow), false, 'the event row is gone');
  assert.equal(exists('task_activities', activityRow), false, 'the activity row is gone');
});

// ── 3. a failed delete must not read as success ─────────────────────────────

test('a failed DELETE on one table rejects with db_retention_partial_failure and the others are still pruned', async () => {
  clearFixtures();
  const doneTask = makeDoneTask();

  const stageRow = seedStageTiming(40);
  const statusRow = seedStatusRow(30);
  seedSseRow(30); // the blocked table
  const eventRow = seedEvent(365);
  const activityRow = seedActivity(doneTask, 365);

  // A missing table would not prove anything — the job skips absent tables. A
  // trigger makes the DELETE itself throw, which is the failure mode under test.
  db.exec(`CREATE TRIGGER block_sse_delete BEFORE DELETE ON sse_event_log
       BEGIN SELECT RAISE(ABORT, 'blocked for test'); END;`);

  let thrown: unknown;
  try {
    await runDbRetention();
  } catch (err) {
    thrown = err;
  } finally {
    db.exec('DROP TRIGGER IF EXISTS block_sse_delete');
  }

  assert.ok(thrown instanceof Error, 'the run must reject, not return as if it succeeded');
  assert.match((thrown as Error).message, /db_retention_partial_failure/);

  // Every other table was still attempted in the same run.
  assert.equal(exists('presentation_stage_timings', stageRow), false, 'stage timing still pruned');
  assert.equal(exists('system_status_snapshots', statusRow), false, 'status snapshot still pruned');
  assert.equal(exists('events', eventRow), false, 'event still pruned');
  assert.equal(exists('task_activities', activityRow), false, 'activity still pruned');

  assert.match(lastRetentionEventMessage(), /FAILED: sse_event_log/, 'the recorded summary names the failed table');
});
