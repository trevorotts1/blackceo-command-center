/**
 * Unit tests for the task-ingest deduplication logic.
 *
 * Covers:
 *   1. normalizeTitle() — lowercase, trim, punctuation collapse
 *   2. Same title + same workspace within window → 1 task, deduped:true on 2nd call
 *   3. Different title → 2 tasks (no dedup)
 *   4. Same title but outside the dedup window → 2 tasks (no dedup)
 *   5. idempotency_key: second call with same key returns prior task, deduped:true
 *   6. idempotency_key: different key → 2 tasks
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Strategy mirrors ceo-ordering-ingest.test.ts: point DATABASE_PATH at a
 * throwaway temp file BEFORE `@/lib/db` is loaded, dynamically import helpers,
 * run the full migration chain against the isolated DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dedup-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
// Speed up dedup checks: use a 60-second window in tests
process.env.DEDUP_WINDOW_SEC = '60';

// ── normalizeTitle unit tests (pure, no DB) ──────────────────────────────────

import { normalizeTitle, DEFAULT_DEDUP_WINDOW_SEC } from '../../src/lib/tasks';

test('normalizeTitle: lowercases', () => {
  assert.equal(normalizeTitle('Hello World'), 'hello world');
});

test('normalizeTitle: trims leading/trailing whitespace', () => {
  assert.equal(normalizeTitle('  hello  '), 'hello');
});

test('normalizeTitle: collapses punctuation to spaces then whitespace', () => {
  // normalizeTitle runs the full pipeline: punct → space, then collapse spaces
  assert.equal(normalizeTitle('follow-up: call!'), 'follow up call');
  assert.equal(normalizeTitle('Follow Up: Call!'), 'follow up call');
});

test('normalizeTitle: collapses runs of whitespace', () => {
  const result = normalizeTitle('  hello   world  ');
  assert.equal(result, 'hello world');
});

test('normalizeTitle: two slightly different titles normalise to same key', () => {
  // Agent may send "Follow up with lead" and "Follow-up with lead" — same task
  assert.equal(normalizeTitle('Follow-up with lead'), normalizeTitle('Follow up with lead'));
  assert.equal(normalizeTitle('Send invoice!'), normalizeTitle('Send invoice'));
});

test('DEFAULT_DEDUP_WINDOW_SEC is 120', () => {
  assert.equal(DEFAULT_DEDUP_WINDOW_SEC, 120);
});

// ── DB-backed dedup tests ────────────────────────────────────────────────────

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

import type { CreateTaskCoreResult } from '../../src/lib/tasks';
let createTaskCoreImpl: (
  input: Parameters<typeof import('../../src/lib/tasks')['createTaskCore']>[0],
  options?: Parameters<typeof import('../../src/lib/tasks')['createTaskCore']>[1],
) => Promise<CreateTaskCoreResult | undefined>;

// Unique run ID to isolate this test file from other files in the same DB
const RUN_ID = Math.random().toString(36).slice(2, 10);

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // runs full migration chain

  // Seed the default company row (FK required by workspaces)
  const now0 = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now0, now0],
  );

  // Seed a test workspace with a unique ID per run to avoid cross-test-file collisions
  const wsId = `ws-dedup-${RUN_ID}`;
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'default', ?, ?, ?)`,
    [wsId, 'Dedup Test', `dedup-test-${RUN_ID}`, 'Test workspace', '🧪', 1, now, now],
  );

  const tasks = await import('../../src/lib/tasks');
  createTaskCoreImpl = tasks.createTaskCore as typeof createTaskCoreImpl;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

test('same title + same workspace within window → 1 task, deduped:true on 2nd call', async () => {
  const wsId = `ws-dedup-${RUN_ID}`;
  const title = `Send the proposal to the client [${RUN_ID}-t1]`;

  const r1 = await createTaskCoreImpl(
    { title, workspace_id: wsId, status: 'backlog', priority: 'medium' },
    { notifyGateway: false },
  );
  assert.ok(r1, 'first call should return a result');
  assert.equal(r1!.deduped, false, 'first call must NOT be deduped');
  const taskId1 = r1!.task.id;

  const r2 = await createTaskCoreImpl(
    { title, workspace_id: wsId, status: 'backlog', priority: 'medium' },
    { notifyGateway: false },
  );
  assert.ok(r2, 'second call should return a result');
  assert.equal(r2!.deduped, true, 'second call MUST be deduped');
  assert.equal(r2!.task.id, taskId1, 'deduped result must point to the first task');
});

test('different title → 2 tasks, no dedup', async () => {
  const wsId = `ws-dedup-${RUN_ID}`;

  const r1 = await createTaskCoreImpl(
    { title: `Alpha task [${RUN_ID}-t2a]`, workspace_id: wsId, status: 'backlog' },
    { notifyGateway: false },
  );
  const r2 = await createTaskCoreImpl(
    { title: `Beta task [${RUN_ID}-t2b]`, workspace_id: wsId, status: 'backlog' },
    { notifyGateway: false },
  );

  assert.ok(r1 && r2, 'both calls must succeed');
  assert.equal(r1!.deduped, false, 'first must not be deduped');
  assert.equal(r2!.deduped, false, 'second must not be deduped (different title)');
  assert.notEqual(r1!.task.id, r2!.task.id, 'must produce 2 distinct tasks');
});

test('same title but outside dedup window → 2 tasks', async () => {
  const wsId = `ws-dedup-${RUN_ID}`;
  const title = `Backdated task [${RUN_ID}-t3]`;
  const now = new Date().toISOString();

  // Manually insert an "old" task outside the 60-second test window
  const oldId = `old-task-${RUN_ID}-outside-window`;
  const oldCreatedAt = new Date(Date.now() - 300_000).toISOString(); // 5 minutes ago
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', ?, 'default', ?, ?)`,
    [oldId, title, wsId, oldCreatedAt, now],
  );

  // A new call with the same title should NOT match the old task (outside window)
  const r = await createTaskCoreImpl(
    { title, workspace_id: wsId, status: 'backlog' },
    { notifyGateway: false },
  );
  assert.ok(r, 'call must succeed');
  assert.equal(r!.deduped, false, 'must not dedup against a task outside the window');
  assert.notEqual(r!.task.id, oldId, 'must create a new task');
});

test('idempotency_key: same key twice → 1 task, deduped:true on 2nd call', async () => {
  const wsId = `ws-dedup-${RUN_ID}`;
  const key = `idem-key-${RUN_ID}-t4`;
  const title = `Task with idempotency key [${RUN_ID}-t4]`;

  const r1 = await createTaskCoreImpl(
    {
      title,
      workspace_id: wsId,
      status: 'backlog',
      idempotency_key: key,
      eventMessage: `Task captured via telegram: ${title} [ingest:${key}]`,
    },
    { notifyGateway: false },
  );
  assert.ok(r1, 'first call must succeed');
  assert.equal(r1!.deduped, false, 'first call must not be deduped');
  const taskId1 = r1!.task.id;

  const r2 = await createTaskCoreImpl(
    {
      title,
      workspace_id: wsId,
      status: 'backlog',
      idempotency_key: key,
      eventMessage: `Task captured via telegram: ${title} [ingest:${key}]`,
    },
    { notifyGateway: false },
  );
  assert.ok(r2, 'second call must succeed');
  assert.equal(r2!.deduped, true, 'second call MUST be deduped via idempotency key');
  assert.equal(r2!.task.id, taskId1, 'deduped result must point to the first task');
});

test('idempotency_key: different key → 2 tasks', async () => {
  const wsId = `ws-dedup-${RUN_ID}`;
  const keyA = `idem-key-${RUN_ID}-t5a`;
  const keyB = `idem-key-${RUN_ID}-t5b`;

  const r1 = await createTaskCoreImpl(
    {
      title: `Task with key alpha [${RUN_ID}-t5a]`,
      workspace_id: wsId,
      status: 'backlog',
      idempotency_key: keyA,
      eventMessage: `Task captured [ingest:${keyA}]`,
    },
    { notifyGateway: false },
  );
  const r2 = await createTaskCoreImpl(
    {
      title: `Task with key beta [${RUN_ID}-t5b]`,
      workspace_id: wsId,
      status: 'backlog',
      idempotency_key: keyB,
      eventMessage: `Task captured [ingest:${keyB}]`,
    },
    { notifyGateway: false },
  );

  assert.ok(r1 && r2, 'both calls must succeed');
  assert.equal(r1!.deduped, false, 'first must not be deduped');
  assert.equal(r2!.deduped, false, 'second must not be deduped (different key + title)');
  assert.notEqual(r1!.task.id, r2!.task.id, 'must produce 2 distinct tasks');
});
