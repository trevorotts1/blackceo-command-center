/**
 * db-retention.test.ts — nightly age-out of append-only diagnostic rows.
 *
 * FAIL-FIRST: against the pre-fix tree `src/lib/jobs/db-retention.ts` does not
 * exist, so every test here fails at import. There was NO retention on any
 * append-only table — presentation_stage_timings alone was measured at 539 MB /
 * 1.48 M rows on the operator box, and nothing ever deleted a row.
 *
 * Coverage:
 *   1. Old rows age out of all four tables; fresh rows survive; the per-table
 *      counts in the result match what actually disappeared.
 *   2. An old `events` row on a LIVE card survives at any age; the same-age row
 *      on a done card is deleted. Live cards keep their whole history.
 *   3. An old `task_activities` row on a LIVE task survives (recent activity is
 *      a liveness signal the stale/stuck sweeps read).
 *   4. DISABLE_DB_RETENTION=1 → skippedReason, nothing deleted.
 *   5. An env override (EVENTS_RETENTION_DAYS=1) is respected.
 *   6. The batch loop continues past one batch: 12,000 old sse_event_log rows
 *      are ALL deleted in a single run (batch size is 5000, so this needs three
 *      passes — a single-batch implementation would leave 7,000 behind).
 *
 * Run: node --import tsx --import ./tests/setup/no-owner-telegram.ts --test tests/unit/db-retention.test.ts
 */

delete process.env.DISABLE_DB_RETENTION;
delete process.env.STAGE_TIMINGS_RETENTION_DAYS;
delete process.env.SSE_EVENT_LOG_RETENTION_DAYS;
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
const WS_ID = `ws-${uuidv4()}`;
run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 910)', [
  WS_ID,
  'Retention WS',
  `retention-${uuidv4().slice(0, 8)}`,
]);

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Clear only the four pruned tables. `tasks` is left alone (other tables
 *  foreign-key into it); each test makes its own task ids. */
function clearFixtures(): void {
  run('DELETE FROM task_activities');
  run('DELETE FROM events');
  run('DELETE FROM sse_event_log');
  run('DELETE FROM presentation_stage_timings');
}

function countOf(table: string): number {
  return queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`, [])?.n ?? 0;
}

function exists(table: string, id: string): boolean {
  return (queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, [id])?.n ?? 0) > 0;
}

/** Create a task in the given state. `done`/`archived` are prunable owners;
 *  `in_progress` is a LIVE card whose rows must never be deleted. */
function makeTask(state: 'live' | 'done' | 'archived'): string {
  const id = `task-${uuidv4()}`;
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `retention ${state}`,
      state === 'live' ? 'in_progress' : 'done',
      WS_ID,
      state === 'archived' ? daysAgoIso(1) : null,
      daysAgoIso(200),
      daysAgoIso(200),
    ],
  );
  return id;
}

function seedEvent(taskId: string | null, ageDays: number): string {
  const id = uuidv4();
  run('INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    'retention_fixture',
    taskId,
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

// ── 1. old rows age out of all four tables, fresh rows survive ───────────────

test('old rows are pruned from all four tables; fresh rows survive; counts match', async () => {
  clearFixtures();
  const doneTask = makeTask('done');

  const oldTiming = seedStageTiming(40); // > 30d default
  const freshTiming = seedStageTiming(1);
  const oldSse = seedSseRow(20); // > 14d default
  const freshSse = seedSseRow(1);
  const oldEvent = seedEvent(doneTask, 100); // > 90d default
  const freshEvent = seedEvent(doneTask, 1);
  const oldActivity = seedActivity(doneTask, 40); // > 30d default
  const freshActivity = seedActivity(doneTask, 1);

  const result = await runDbRetention();

  assert.equal(result.skippedReason, undefined, 'no kill flag set, so no skip');
  assert.equal(result.budgetExhausted, false, '8 fixture rows cannot exhaust a 60s budget');

  assert.deepEqual(
    result.deleted,
    {
      presentation_stage_timings: 1,
      sse_event_log: 1,
      events: 1,
      task_activities: 1,
    },
    'exactly one old row deleted per table',
  );

  const timingRowIds = db
    .prepare('SELECT id FROM presentation_stage_timings')
    .all()
    .map((r) => (r as { id: number }).id);
  assert.deepEqual(timingRowIds, [freshTiming], 'only the fresh stage timing remains');
  assert.ok(!timingRowIds.includes(oldTiming), 'the 40-day stage timing is gone');

  const sseRowIds = db
    .prepare('SELECT id FROM sse_event_log')
    .all()
    .map((r) => (r as { id: number }).id);
  assert.deepEqual(sseRowIds, [freshSse], 'only the fresh sse row remains');
  assert.ok(!sseRowIds.includes(oldSse), 'the 20-day sse row is gone');

  assert.equal(exists('events', oldEvent), false, 'the 100-day event is gone');
  assert.equal(exists('events', freshEvent), true, 'the 1-day event survives');
  assert.equal(exists('task_activities', oldActivity), false, 'the 40-day activity is gone');
  assert.equal(exists('task_activities', freshActivity), true, 'the 1-day activity survives');

  // The run records itself, board-wide (task_id NULL), with the summary line.
  const ran = queryOne<{ n: number; message: string }>(
    `SELECT COUNT(*) AS n, MAX(message) AS message FROM events WHERE type = 'db_retention_ran' AND task_id IS NULL`,
    [],
  );
  assert.equal(ran?.n, 1, 'exactly one db_retention_ran event written');
  assert.match(
    ran?.message ?? '',
    /deleted stage_timings=1 sse_event_log=1 events=1 task_activities=1 in [\d.]+s; \d+ free pages/,
    'the recorded summary carries the per-table counts',
  );

  // Freelist / size are read from the live PRAGMAs, not invented.
  assert.ok(result.freelistPagesAfter >= 0, 'freelist page count reported');
  assert.ok(result.dbSizeBytesAfter > 0, 'database size reported');
});

// ── 2. events: a live card keeps its history at any age ──────────────────────

test('an old events row on a LIVE card survives; the same-age row on a done card is deleted', async () => {
  clearFixtures();
  const liveTask = makeTask('live');
  const doneTask = makeTask('done');
  const archivedTask = makeTask('archived');

  const liveOld = seedEvent(liveTask, 400); // more than a year old, but live
  const doneOld = seedEvent(doneTask, 400);
  const archivedOld = seedEvent(archivedTask, 400);
  const orphanOld = seedEvent(null, 400); // board-wide, no owning card

  const result = await runDbRetention();

  assert.equal(exists('events', liveOld), true, 'a live card keeps its history regardless of age');
  assert.equal(exists('events', doneOld), false, 'a done card sheds its old events');
  assert.equal(exists('events', archivedOld), false, 'an archived card sheds its old events');
  assert.equal(exists('events', orphanOld), false, 'a board-wide old event is prunable');
  assert.equal(result.deleted.events, 3, 'three of the four old events deleted, the live one spared');
});

// ── 3. task_activities: a live task keeps its activity trail ─────────────────

test('an old task_activities row on a LIVE task survives', async () => {
  clearFixtures();
  const liveTask = makeTask('live');
  const doneTask = makeTask('done');

  const liveOld = seedActivity(liveTask, 365);
  const doneOld = seedActivity(doneTask, 365);

  const result = await runDbRetention();

  assert.equal(exists('task_activities', liveOld), true, 'a live task keeps its liveness signal');
  assert.equal(exists('task_activities', doneOld), false, 'a done task sheds its old activities');
  assert.equal(result.deleted.task_activities, 1, 'only the done task lost a row');
});

// ── 4. kill flag ─────────────────────────────────────────────────────────────

test('DISABLE_DB_RETENTION=1 skips the job and deletes nothing', async () => {
  clearFixtures();
  const doneTask = makeTask('done');
  seedStageTiming(400);
  seedSseRow(400);
  seedEvent(doneTask, 400);
  seedActivity(doneTask, 400);

  process.env.DISABLE_DB_RETENTION = '1';
  let result;
  try {
    result = await runDbRetention();
  } finally {
    delete process.env.DISABLE_DB_RETENTION;
  }

  assert.equal(result.skippedReason, 'DISABLE_DB_RETENTION set');
  assert.deepEqual(result.deleted, {
    presentation_stage_timings: 0,
    sse_event_log: 0,
    events: 0,
    task_activities: 0,
  });
  assert.equal(countOf('presentation_stage_timings'), 1, 'stage timing untouched');
  assert.equal(countOf('sse_event_log'), 1, 'sse row untouched');
  assert.equal(countOf('task_activities'), 1, 'activity untouched');
  assert.equal(countOf('events'), 1, 'event untouched and NO db_retention_ran row written');
});

// ── 5. env override ──────────────────────────────────────────────────────────

test('EVENTS_RETENTION_DAYS=1 is respected (and an invalid value falls back)', async () => {
  clearFixtures();
  const doneTask = makeTask('done');
  const threeDays = seedEvent(doneTask, 3); // survives the 90d default
  const hoursOld = seedEvent(doneTask, 0.25);

  process.env.EVENTS_RETENTION_DAYS = '1';
  let result;
  try {
    result = await runDbRetention();
  } finally {
    delete process.env.EVENTS_RETENTION_DAYS;
  }

  assert.equal(exists('events', threeDays), false, '3-day event deleted under a 1-day retention');
  assert.equal(exists('events', hoursOld), true, 'a hours-old event still survives');
  assert.equal(result.deleted.events, 1);

  // An invalid override must fall back to the 90-day default, never delete all.
  clearFixtures();
  const survivor = seedEvent(doneTask, 3);
  process.env.EVENTS_RETENTION_DAYS = 'not-a-number';
  try {
    await runDbRetention();
  } finally {
    delete process.env.EVENTS_RETENTION_DAYS;
  }
  assert.equal(exists('events', survivor), true, 'a garbage override falls back to the 90-day default');
});

// ── 6. the batch loop continues past one batch ───────────────────────────────

test('12,000 old sse_event_log rows are ALL deleted in one run (batch loop continues)', async () => {
  clearFixtures();

  const stmt = db.prepare(
    `INSERT INTO sse_event_log (origin, event_type, payload, created_at) VALUES ('bulk', 'fixture', '{}', ?)`,
  );
  const old = daysAgoIso(30);
  const insertMany = db.transaction((n: number) => {
    for (let i = 0; i < n; i += 1) stmt.run(old);
  });
  insertMany(12_000);
  seedSseRow(1); // one fresh row that must survive

  assert.equal(countOf('sse_event_log'), 12_001, 'fixture seeded');

  const result = await runDbRetention();

  assert.equal(
    result.deleted.sse_event_log,
    12_000,
    'all 12,000 old rows deleted — a single 5000-row batch would report 5000',
  );
  assert.equal(countOf('sse_event_log'), 1, 'only the fresh row remains');
  assert.equal(result.budgetExhausted, false, '12k rows finish well inside the 60s budget');
});
