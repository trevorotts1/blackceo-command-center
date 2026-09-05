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
 *   7. Layer-1 precedence: different idempotency_key + IDENTICAL title within the
 *      window → 2 tasks (the anthology two-anthologies-one-contact regression:
 *      a distinct idempotency key must NOT be collapsed by the title window)
 *   8. same idempotency_key still dedups across the title window (Layer 1 intact)
 *   9. keyless same-title within window STILL dedups (Layer 2 preserved for
 *      callers that supply no idempotency key)
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Strategy mirrors ceo-ordering-ingest.test.ts: point DATABASE_PATH at a
 * throwaway temp file BEFORE `@/lib/db` is loaded, dynamically import helpers,
 * run the full migration chain against the isolated DB.
 */

// C8 — DB isolation MUST happen in an IMPORTED module, and this MUST stay the
// first import. Assigning process.env.DATABASE_PATH in this file's BODY does not
// work: ES `import` declarations are HOISTED, so any statically-imported project
// module that transitively reaches '@/lib/db' is evaluated FIRST — freezing
// `export const DB_PATH = process.env.DATABASE_PATH || <cwd>/mission-control.db`
// from the un-isolated env. This suite did exactly that and silently opened,
// migrated and wrote the LIVE mission-control.db. Proven by deleting the file and
// re-running this suite alone: it came back.
// Enforced by tests/unit/c8-db-isolation-guard.test.ts.
import './_isolated-db';

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
let queryAll: DbModule['queryAll'];

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
  queryAll = db.queryAll;
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

test('different idempotency_key + IDENTICAL title within window → 2 tasks (Layer 1 beats Layer 2)', async () => {
  // The W5.6 canary bug: one contact enrolled in TWO different anthologies
  // produces two cards with the SAME title but DISTINCT idempotency keys. The
  // generic title+workspace window (Layer 2) must NOT collapse them — a present,
  // distinct idempotency key (Layer 1) takes precedence.
  const wsId = `ws-dedup-${RUN_ID}`;
  const title = `Anthology chapter — Same Contact [${RUN_ID}-t6]`; // identical title
  const keyA = `anthology:card:CONTACT-${RUN_ID}::ANTH-A`;
  const keyB = `anthology:card:CONTACT-${RUN_ID}::ANTH-B`;

  const r1 = await createTaskCoreImpl(
    {
      title,
      workspace_id: wsId,
      status: 'backlog',
      idempotency_key: keyA,
      eventMessage: `Task captured via anthology: ${title} [ingest:${keyA}]`,
    },
    { notifyGateway: false },
  );
  const r2 = await createTaskCoreImpl(
    {
      title, // SAME title, within the window
      workspace_id: wsId,
      status: 'backlog',
      idempotency_key: keyB,
      eventMessage: `Task captured via anthology: ${title} [ingest:${keyB}]`,
    },
    { notifyGateway: false },
  );

  assert.ok(r1 && r2, 'both calls must succeed');
  assert.equal(r1!.deduped, false, 'first must not be deduped');
  assert.equal(
    r2!.deduped,
    false,
    'second MUST NOT be deduped: a distinct idempotency key (Layer 1) must beat the title window (Layer 2)',
  );
  assert.notEqual(
    r1!.task.id,
    r2!.task.id,
    'two anthologies for one contact must produce 2 distinct task rows, not one shared row',
  );
});

test('same idempotency_key still dedups across the title window (Layer 1 intact)', async () => {
  // Guard against over-correction: a genuine retry with the SAME key must still
  // return the prior task, even though Layer 2 is now skipped for keyed calls.
  const wsId = `ws-dedup-${RUN_ID}`;
  const key = `anthology:card:CONTACT-${RUN_ID}::ANTH-SAME`;
  const title = `Anthology chapter — Repeat Contact [${RUN_ID}-t7]`;

  const r1 = await createTaskCoreImpl(
    { title, workspace_id: wsId, status: 'backlog', idempotency_key: key, eventMessage: `x [ingest:${key}]` },
    { notifyGateway: false },
  );
  const r2 = await createTaskCoreImpl(
    { title, workspace_id: wsId, status: 'backlog', idempotency_key: key, eventMessage: `x [ingest:${key}]` },
    { notifyGateway: false },
  );

  assert.ok(r1 && r2, 'both calls must succeed');
  assert.equal(r1!.deduped, false, 'first must not be deduped');
  assert.equal(r2!.deduped, true, 'same idempotency key MUST still dedupe (Layer 1 unchanged)');
  assert.equal(r2!.task.id, r1!.task.id, 'deduped result must point to the first task');
});

// ── FIX 40: Layer 1 must skip DEAD tasks (archived or vanished rows) ─────────

test('FIX 40: archived prior task under same key → falls through, inserts live card, 2nd ingest dedupes onto it', async () => {
  const wsId = `ws-dedup-${RUN_ID}`;
  const key = `dead-key-${RUN_ID}-f40a`;
  const title = `Archived-key retry [${RUN_ID}-f40a]`;

  // Seed a task_created event for key K pointing at an ARCHIVED task id —
  // exactly the pre-existing state that made the old ASC LIMIT 1 dedupe either
  // return a dead card or wedge the key forever.
  const deadId = `dead-task-${RUN_ID}-f40a`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, archived_at, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', ?, 'default', ?, ?, ?)`,
    [deadId, `${title} (dead)`, wsId, now, now, now],
  );
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'task_created', ?, ?, ?)`,
    [`evt-${RUN_ID}-f40a-seed`, deadId, `Task captured [ingest:${key}]`, now],
  );

  // PROOF: ingest with key K — no new task is inserted and the response is
  // deduped:true against the newest LIVE match… but there is no live match
  // under this key, so the contract is: fall through to insert, then the next
  // ingest with K dedupes onto it.
  const r1 = await createTaskCoreImpl(
    {
      title,
      workspace_id: wsId,
      status: 'backlog',
      idempotency_key: key,
      eventMessage: `Task captured [ingest:${key}]`,
    },
    { notifyGateway: false },
  );
  assert.ok(r1, 'first ingest must succeed');
  assert.equal(r1!.deduped, false, 'no live match under the key → must INSERT, not dedupe onto the dead card');
  assert.notEqual(r1!.task.id, deadId, 'must NOT return the archived task');

  // Second ingest with the same key dedupes onto the fresh live card.
  const r2 = await createTaskCoreImpl(
    {
      title,
      workspace_id: wsId,
      status: 'backlog',
      idempotency_key: key,
      eventMessage: `Task captured [ingest:${key}]`,
    },
    { notifyGateway: false },
  );
  assert.ok(r2, 'second ingest must succeed');
  assert.equal(r2!.deduped, true, 'second ingest MUST dedupe onto the fresh live card');
  assert.equal(r2!.task.id, r1!.task.id, 'deduped result must point at the live card, never the archived one');
});

test('FIX 40: event pointing at a deleted task id is skipped, insert proceeds', async () => {
  const wsId = `ws-dedup-${RUN_ID}`;
  const key = `dead-key-${RUN_ID}-f40b`;
  const title = `Vanished-row retry [${RUN_ID}-f40b]`;

  const now = new Date().toISOString();
  // events.task_id carries an FK to tasks(id), so a dangling event row can only
  // be created with FK enforcement suspended for that one insert (the same way
  // historical deletes/pre-FK data can leave one behind in the wild).
  run('PRAGMA foreign_keys = OFF');
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'task_created', ?, ?, ?)`,
    [`evt-${RUN_ID}-f40b-seed`, `gone-task-${RUN_ID}-f40b`, `Task captured [ingest:${key}]`, now],
  );
  run('PRAGMA foreign_keys = ON');

  const r1 = await createTaskCoreImpl(
    {
      title,
      workspace_id: wsId,
      status: 'backlog',
      idempotency_key: key,
      eventMessage: `Task captured [ingest:${key}]`,
    },
    { notifyGateway: false },
  );
  assert.ok(r1, 'first ingest must succeed');
  assert.equal(r1!.deduped, false, 'missing task row must be skipped → insert');
});

test('FIX 40: dead event + live event under same key → dedupes onto the LIVE (newest-first scan), not the dead one', async () => {
  const wsId = `ws-dedup-${RUN_ID}`;
  const key = `mixed-key-${RUN_ID}-f40c`;
  const title = `Mixed dead/live key [${RUN_ID}-f40c]`;

  const now = new Date().toISOString();
  const deadId = `dead-task-${RUN_ID}-f40c`;
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, archived_at, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', ?, 'default', ?, ?, ?)`,
    [deadId, `${title} (dead)`, wsId, now, now, now],
  );
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'task_created', ?, ?, ?)`,
    [`evt-${RUN_ID}-f40c-dead`, deadId, `Task captured [ingest:${key}]`, now],
  );

  // Live card created the normal way (logs its own task_created event with the key).
  const live = await createTaskCoreImpl(
    {
      title,
      workspace_id: wsId,
      status: 'backlog',
      idempotency_key: key,
      eventMessage: `Task captured [ingest:${key}]`,
    },
    { notifyGateway: false },
  );
  assert.ok(live && live.deduped === false, 'live card must insert cleanly');

  const again = await createTaskCoreImpl(
    {
      title,
      workspace_id: wsId,
      status: 'backlog',
      idempotency_key: key,
      eventMessage: `Task captured [ingest:${key}]`,
    },
    { notifyGateway: false },
  );
  assert.ok(again, 're-ingest must succeed');
  assert.equal(again!.deduped, true, 'must dedupe');
  assert.equal(again!.task.id, live!.task.id, 'must land on the LIVE card, skipping the archived one');

  const taskCount = queryAll<{ n: number }>(
    "SELECT COUNT(*) as n FROM tasks WHERE workspace_id = ? AND title LIKE ? AND archived_at IS NULL AND id != ?",
    [wsId, `%${RUN_ID}-f40c%`, deadId],
  )[0]?.n ?? 0;
  assert.equal(taskCount, 1, 'exactly one live task row must exist for this key');
});

test('keyless same-title within window STILL dedups (Layer 2 preserved for keyless callers)', async () => {
  // The fix must NOT weaken Layer 2 for callers WITHOUT an idempotency key
  // (operator UI, plain Telegram capture): accidental same-title dupes still fold
  // onto the existing row.
  const wsId = `ws-dedup-${RUN_ID}`;
  const title = `Keyless same-title capture [${RUN_ID}-t8]`;

  const r1 = await createTaskCoreImpl(
    { title, workspace_id: wsId, status: 'backlog' }, // no idempotency_key
    { notifyGateway: false },
  );
  const r2 = await createTaskCoreImpl(
    { title, workspace_id: wsId, status: 'backlog' }, // no idempotency_key
    { notifyGateway: false },
  );

  assert.ok(r1 && r2, 'both calls must succeed');
  assert.equal(r1!.deduped, false, 'first must not be deduped');
  assert.equal(r2!.deduped, true, 'keyless same-title within window MUST still dedupe (Layer 2 intact)');
  assert.equal(r2!.task.id, r1!.task.id, 'deduped result must point to the first task');
});

// Reliability batch: exercise the actual async creation function, not a mock deduper.
test('twenty concurrent retries commit one task, creation event and dispatch intent', async () => {
  const input = { title: `Concurrent operation ${RUN_ID}`, workspace_id: `ws-dedup-${RUN_ID}`,
    status: 'backlog', idempotency_key: `concurrent-${RUN_ID}` };
  const results = await Promise.all(Array.from({ length: 20 }, () => createTaskCoreImpl(input, { notifyGateway: false })));
  assert.equal(new Set(results.map(r => r?.task.id)).size, 1);
  assert.equal(results.filter(r => r?.deduped === false).length, 1);
  const id = results[0]!.task.id;
  assert.equal(queryAll<{n:number}>("SELECT COUNT(*) n FROM events WHERE task_id=? AND type='task_created'", [id])[0].n, 1);
  assert.equal(queryAll<{n:number}>('SELECT COUNT(*) n FROM task_dispatch_intents WHERE task_id=?', [id])[0].n, 1);
});

test('conflicting operation reuse refuses changed instructions', async () => {
  const input = { title: `Payload conflict ${RUN_ID}`, description: 'Original instructions',
    workspace_id: `ws-dedup-${RUN_ID}`, idempotency_key: `conflict-${RUN_ID}` };
  await createTaskCoreImpl(input, { notifyGateway: false });
  await assert.rejects(createTaskCoreImpl({ ...input, description: 'Different instructions' }, { notifyGateway: false }), /different task instructions/);
});

test('archiving a recorded operation preserves retry identity; reruns use a new operation', async () => {
  const input = { title: `Archived operation ${RUN_ID}`, workspace_id: `ws-dedup-${RUN_ID}`,
    idempotency_key: `archive-operation-${RUN_ID}` };
  const first = await createTaskCoreImpl(input, { notifyGateway: false });
  run('UPDATE tasks SET archived_at=? WHERE id=?', [new Date().toISOString(), first!.task.id]);
  const retry = await createTaskCoreImpl(input, { notifyGateway: false });
  assert.equal(retry!.task.id, first!.task.id);
  assert.equal(retry!.deduped, true);
  const rerun = await createTaskCoreImpl({ ...input, idempotency_key: `${input.idempotency_key}-new` }, { notifyGateway: false });
  assert.notEqual(rerun!.task.id, first!.task.id);
});
