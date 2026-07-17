/**
 * U44 (master spec v2 C-13, C+I.2 line 1190) — recurrence-detector fixture
 * proof.
 *
 * BINARY acceptance (c): "recurrence fixture yields exactly one recommendation
 * row, and a second run updates-not-duplicates it."
 *
 * runGeneralTaskRecurrenceDetection() (src/lib/jobs/general-task-recurrence.ts)
 * already exists in the codebase and is wired into the weekly scheduler
 * (scheduler.ts:35,630-648) — but at the parent commit
 * (d2f3ac124179c75c34139dfb3d8241dea7ea195e) NOTHING imports or exercises it
 * from a test. This file is the first regression lock on that function: it
 * drives the REAL production function against a real (isolated, temp) SQLite
 * DB seeded through the REAL createTaskCore write path — never a
 * reimplementation of the clustering/upsert SQL.
 *
 * This is proof-of-already-built-code, not a bug fix (the master spec's own
 * ledger says so: line 1245, "catch-all found ALREADY BUILT in code — unit is
 * conformance + naming + producer-doc fix"). Accordingly this suite is
 * expected to pass on BOTH the parent commit and the fix — that is the
 * correct, honest result for a regression-lock test of pre-existing, correct
 * behavior. What proves this test is not decoration is the MUTATION check:
 * temporarily breaking MIN_CLUSTER_SIZE, the upsert's dedupe WHERE clause, or
 * the department filter must turn a red test (see PR description / commit
 * body for the mutation log — each mutation was applied and reverted by hand
 * against this exact suite).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u44-recurrence-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';

const RUN_ID = Math.random().toString(36).slice(2, 10);
const GENERAL_WS_ID = `ws-general-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type TasksModule = typeof import('../../src/lib/tasks');
let createTaskCore: TasksModule['createTaskCore'];

type RecurrenceModule = typeof import('../../src/lib/jobs/general-task-recurrence');
let runGeneralTaskRecurrenceDetection: RecurrenceModule['runGeneralTaskRecurrenceDetection'];

// Four titles that share the SAME first non-stopword token ("notarize"), so
// clusterGeneralTasks() groups them under one primary-keyword cluster
// (MIN_CLUSTER_SIZE = 4 in general-task-recurrence.ts:55).
const CLUSTER_TITLES = [
  `Notarize the contract with Acme Corp [${RUN_ID}]`,
  `Notarize the agreement for Beta LLC [${RUN_ID}]`,
  `Notarize paperwork for Gamma Industries [${RUN_ID}]`,
  `Notarize forms for Delta Holdings [${RUN_ID}]`,
];

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // full migration chain

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'general-task', 'General Task', '📋', 'default', 99, ?, ?)`,
    [GENERAL_WS_ID, now, now],
  );

  const tasks = (await import('../../src/lib/tasks')) as TasksModule;
  createTaskCore = tasks.createTaskCore;

  const recurrence = (await import('../../src/lib/jobs/general-task-recurrence')) as RecurrenceModule;
  runGeneralTaskRecurrenceDetection = recurrence.runGeneralTaskRecurrenceDetection;

  // Seed the 4-card cluster via the REAL task-creation path.
  for (const title of CLUSTER_TITLES) {
    const result = await createTaskCore(
      {
        title,
        status: 'backlog',
        priority: 'medium',
        assigned_agent_id: null,
        created_by_agent_id: null,
        workspace_id: GENERAL_WS_ID,
        department: 'general-task',
        eventMessage: `Task captured via ingest: ${title}`,
        idempotency_key: null,
      },
      { notifyGateway: false },
    );
    assert.ok(result, `fixture task "${title}" must be created`);
  }
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

function recommendationRows(): { id: string; status: string; supporting_data: string | null }[] {
  return queryAll<{ id: string; status: string; supporting_data: string | null }>(
    `SELECT id, status, supporting_data FROM recommendations
      WHERE department_id = 'general-task' AND category = 'try'
        AND supporting_data LIKE ?`,
    [`%${RUN_ID}%`],
  );
}

test('recurrence fixture: 4 similar general-task cards in the 30d window -> exactly ONE recommendation row', () => {
  const result = runGeneralTaskRecurrenceDetection();

  assert.equal(result.scanned_tasks, CLUSTER_TITLES.length, 'must scan exactly the 4 seeded fixture cards');
  assert.equal(result.clusters_found, 1, 'the 4 cards must cluster into exactly ONE cluster (shared "notarize" keyword)');
  assert.equal(result.recommendations_created, 1, 'first run must CREATE the recommendation');

  const rows = recommendationRows();
  assert.equal(rows.length, 1, 'exactly one recommendations row must exist for this cluster');
  assert.equal(rows[0].status, 'pending', 'a freshly created recommendation starts pending');

  const data = JSON.parse(rows[0].supporting_data ?? '{}') as { count: number; signatureKeywords: string[] };
  assert.equal(data.count, 4, 'supporting_data must record all 4 clustered task ids');
  assert.ok(
    data.signatureKeywords.includes('notarize'),
    'the cluster signature must include the shared keyword',
  );
});

test('recurrence fixture: a second run UPDATEs the existing row instead of duplicating it', () => {
  const before = recommendationRows();
  assert.equal(before.length, 1, 'precondition: exactly one row exists after the first run');
  const idBefore = before[0].id;

  const result = runGeneralTaskRecurrenceDetection();

  assert.equal(result.clusters_found, 1, 'second run must still find the one cluster');
  assert.equal(result.recommendations_created, 0, 'second run must NOT create a new row');
  assert.equal(result.recommendations_upserted, 1, 'second run must still upsert (update) the row');

  const after = recommendationRows();
  assert.equal(after.length, 1, 'idempotent: still exactly ONE recommendation row after the second run, never two');
  assert.equal(after[0].id, idBefore, 'the SAME row must be updated, not replaced by a new id');
});
