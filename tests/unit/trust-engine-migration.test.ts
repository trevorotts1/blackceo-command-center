/**
 * P1-04 — Trust engine schema + requester-capture tests.
 *
 * FAIL-FIRST: against the pre-P1-04 tree these tests fail — migration 098 does
 * not exist and schema.ts lacks the eight report-back columns, so PRAGMA
 * table_info(tasks) does not list them and createTaskCore's INSERT never carries
 * requester_channel / requester_chat_id. With the fix they pass.
 *
 * Strategy mirrors ceo-ordering-ingest.test.ts: point DATABASE_PATH at a throwaway
 * temp file BEFORE `@/lib/db` is loaded, then dynamically import so the test binds
 * to the isolated DB and runs the real migration chain (including 098).
 *
 * Covers:
 *   1. Migration 098 adds all eight trust-engine columns + the requester index.
 *   2. A direct INSERT using those columns round-trips (they are writable TEXT).
 *   3. createTaskCore() threads requester_channel + requester_chat_id onto the row.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-trust-migration-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
// Keep createTaskCore inert: no gateway sends, no owner notifications during the test.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

type DbModule = typeof import('../../src/lib/db');
let getDb: DbModule['getDb'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];

type TasksModule = typeof import('../../src/lib/tasks');
let createTaskCore: TasksModule['createTaskCore'];

const TRUST_COLUMNS = [
  'requester_channel',
  'requester_chat_id',
  'ack_sent_at',
  'progress_last_sent_at',
  'eta_estimate',
  'completion_sent_at',
  'result_summary',
  'result_location',
];

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  run = db.run;
  closeDb = db.closeDb;

  // getDb() runs the full migration chain (incl. 098) against the temp DB.
  getDb();

  const tasksMod = await import('../../src/lib/tasks');
  createTaskCore = tasksMod.createTaskCore;

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'default', ?, ?, ?)`,
    ['ws-sales', 'Sales', 'sales', 'Sales dept', '💼', 10, now, now],
  );
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

test('migration 098: tasks has all eight trust-engine columns after the migration chain', () => {
  const cols = new Set(
    queryAll<{ name: string }>('PRAGMA table_info(tasks)').map((c) => c.name),
  );
  for (const col of TRUST_COLUMNS) {
    assert.ok(cols.has(col), `tasks must have trust-engine column ${col} after migration 098`);
  }
});

test('migration 098: the requester_chat_id partial index exists', () => {
  const idx = queryOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_requester_chat'",
  );
  assert.equal(idx?.name, 'idx_tasks_requester_chat', 'idx_tasks_requester_chat must exist');
});

test('the eight columns are writable TEXT and round-trip on a direct INSERT', () => {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id,
        requester_channel, requester_chat_id, ack_sent_at, progress_last_sent_at,
        eta_estimate, completion_sent_at, result_summary, result_location,
        created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', 'ws-sales', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'task-direct', 'Direct insert', 'telegram', '55501', now, null,
      'within 24 hours', null, null, null, now, now,
    ],
  );
  const row = queryOne<{ requester_channel: string; requester_chat_id: string; eta_estimate: string }>(
    'SELECT requester_channel, requester_chat_id, eta_estimate FROM tasks WHERE id = ?',
    ['task-direct'],
  );
  assert.equal(row?.requester_channel, 'telegram');
  assert.equal(row?.requester_chat_id, '55501');
  assert.equal(row?.eta_estimate, 'within 24 hours');
});

test('createTaskCore captures requester_channel + requester_chat_id at ingest', async () => {
  const result = await createTaskCore(
    {
      title: 'Client asked for a sales one-pager',
      status: 'backlog',
      workspace_id: 'ws-sales',
      department: 'sales',
      requester_channel: 'telegram',
      requester_chat_id: '99988877',
    },
    { notifyGateway: false },
  );
  assert.ok(result, 'createTaskCore must return a result');
  const row = queryOne<{ requester_channel: string | null; requester_chat_id: string | null }>(
    'SELECT requester_channel, requester_chat_id FROM tasks WHERE id = ?',
    [result!.task.id],
  );
  assert.equal(row?.requester_channel, 'telegram', 'requester_channel must be stored');
  assert.equal(row?.requester_chat_id, '99988877', 'requester_chat_id must be stored');
});

test('createTaskCore leaves requester columns NULL for an operator/internal task', async () => {
  const result = await createTaskCore(
    { title: 'Internal operator task', status: 'backlog', workspace_id: 'ws-sales' },
    { notifyGateway: false },
  );
  assert.ok(result);
  const row = queryOne<{ requester_channel: string | null; requester_chat_id: string | null }>(
    'SELECT requester_channel, requester_chat_id FROM tasks WHERE id = ?',
    [result!.task.id],
  );
  assert.equal(row?.requester_channel, null, 'no requester_channel for internal tasks');
  assert.equal(row?.requester_chat_id, null, 'no requester_chat_id for internal tasks');
});
