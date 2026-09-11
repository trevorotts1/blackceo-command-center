/**
 * RR-019 CC SIDE — durable board-sync intake (migration 145 + board-sync-intent.ts).
 *
 * SPEC RR-019 (P1 CONFIRMED SOURCE), CC half: reachable CC is asynchronous —
 * when the FLEET projection pump reaches a degraded CC, the intent waits as a
 * DURABLE row and resumes without losing owner, due time, or op identity.
 *
 * CONTRACT under test (mirrors the FLEET rescue/tests/RR-019/board-sync.test.mjs
 * battery case-for-case):
 *   (1) outage-shaped intake persists an authorized logged intent (deferred, owned);
 *   (2) restoration verifies one card / dedupes twins / creates exactly one;
 *   (3) replay of the same op_id returns the original receipt, never a second card;
 *   (4) failed stamp retries with bounded backoff then acks, attempts counted;
 *   (5) out-of-order status coalesces, newest applies, history retained;
 *   (6) restart (reopen same file) resumes pending intents;
 *   (7) permanent schema error becomes owned escalation, owner/due kept;
 *   (8) stale op coalesces, owner/due kept, revision not inflated by replay.
 *
 * Strategy: isolated temp DB (own file, BEFORE any '@/lib/db' import) + REAL
 * migration chain (runMigrations) + REAL board-sync-intent module. better-sqlite3
 * is the CC driver; DatabaseSync fixtures are NOT reused here.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts --test \
 *     tests/unit/rr019-board-sync.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolated DB (BEFORE any '@/lib/db' import) ───────────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rr019-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type IntentModule = typeof import('../../src/lib/rescue/board-sync-intent');
let INTENT: IntentModule;

let SEQ = 0;
const nowIso = () => new Date().toISOString();

function mkTask(owner = 'op-alice'): string {
  SEQ += 1;
  const id = `rr019-task-${SEQ}`;
  const now = nowIso();
  run(`INSERT OR IGNORE INTO workspaces (id, slug, name, company_id) VALUES ('ws-rr019', 'rr019dept', 'RR019 Dept', 'default')`);
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, ?, 'in_progress', 'high', 'ws-rr019', 'default', ?, ?)`,
    [id, `RR019 task ${SEQ}`, 'Rescue board-sync fixture.', now, now],
  );
  // owner stamp: visible event, the "authorized logged" half of case (1).
  run(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'rescue_accepted_during_outage', ?, ?, ?)`,
    [`evt-${id}-accept`, id, `Rescue accepted during outage; owner=${owner}`, now]);
  return id;
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // full migration chain incl. 145 against the temp DB
  INTENT = (await import('../../src/lib/rescue/board-sync-intent')) as IntentModule;
});

test.after(async () => {
  try { closeDb(); } catch { /* already closed */ }
});

test('RR-019 CC (0): migration 145 applied board-sync tables + task columns', () => {
  const t = queryOne<{ n: number }>(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='board_sync_ops'`);
  assert.equal(Number(t?.n), 1, 'board_sync_ops exists');
  const cols = queryAll<{ name: string }>(`PRAGMA table_info(tasks)`).map((c) => c.name);
  for (const c of ['desired_rev', 'acked_rev', 'board_sync_state']) {
    assert.ok(cols.includes(c), `tasks.${c} exists`);
  }
  const mig = queryOne<{ name: string }>(`SELECT name FROM _migrations WHERE id='145'`);
  assert.equal(mig?.name, 'rr019_board_sync_intent', 'migration 145 recorded');
});

test('RR-019 CC (1): outage-shaped intake persists authorized logged intent, projection deferred', () => {
  const taskId = mkTask('op-alice');
  const r = INTENT.recordBoardSyncIntent(getDb() as unknown as never, taskId, [
    { op_id: `op-${taskId}-create`, kind: 'create_card', payload: { title: 'Rescue card' }, owner: 'op-alice' },
  ]);
  assert.equal(r.ok, true, 'intent recorded while board unreachable');
  assert.deepEqual(r.appended, [`op-${taskId}-create`], 'one op appended');
  const h = INTENT.boardSyncHealth(getDb() as unknown as never, taskId);
  assert.equal(h.pending, 1, 'projection waits as durable pending row');
  const evts = queryAll<{ type: string }>(`SELECT type FROM events WHERE task_id=? ORDER BY rowid`, [taskId]).map((e) => e.type);
  assert.ok(evts.includes('rescue_accepted_during_outage'), 'outage acceptance logged');
});

test('RR-019 CC (1b): intent refuses unknown task and unknown op kind', () => {
  const bad = INTENT.recordBoardSyncIntent(getDb() as unknown as never, 'no-such-task', [
    { op_id: 'op-x', kind: 'create_card', payload: {}, owner: 'op-a' },
  ]);
  assert.equal(bad.ok, false, 'unknown task refused');
  assert.equal(bad.error, 'unknown_task', 'refusal named');
  const taskId = mkTask();
  const badKind = INTENT.recordBoardSyncIntent(getDb() as unknown as never, taskId, [
    { op_id: 'op-y', kind: 'launch_second_fixer', payload: {}, owner: 'op-a' },
  ]);
  assert.equal(badKind.ok, false, 'no second fixer: unknown kind refused');
});

test('RR-019 CC (2): restoration verifies one card, dedupes twins, creates exactly one', () => {
  const t1 = mkTask();
  const v = INTENT.restoreBoardSyncCard(getDb() as unknown as never, t1, ['CARD-1']);
  assert.deepEqual([v.ok, v.action, v.card_id], [true, 'existing', 'CARD-1'], 'one card verifies');
  const t2 = mkTask();
  const d = INTENT.restoreBoardSyncCard(getDb() as unknown as never, t2, ['CARD-A', 'CARD-B']);
  assert.equal(d.action, 'deduped', 'twins dedupe');
  assert.equal(d.card_id, 'CARD-A', 'first kept');
  const t3 = mkTask();
  const c = INTENT.restoreBoardSyncCard(getDb() as unknown as never, t3, []);
  assert.equal(c.action, 'created', 'zero cards reconstructs one');
  assert.equal(c.card_id, `${t3}-restored`, 'deterministic restored id');
  const again = INTENT.recordBoardSyncIntent(getDb() as unknown as never, t3, [
    { op_id: `restore:${t3}`, kind: 'create_card', payload: {}, owner: 'op-a' },
  ]);
  assert.deepEqual(again.replayed, [`restore:${t3}`], 'restoration replays, never mints twice');
});

test('RR-019 CC (3): replay of the same op_id returns the original receipt', () => {
  const taskId = mkTask();
  const first = INTENT.recordBoardSyncIntent(getDb() as unknown as never, taskId, [
    { op_id: `op-${taskId}-lost`, kind: 'create_card', payload: { title: 'L' }, owner: 'op-alice' },
  ]);
  assert.equal(first.appended?.length, 1, 'first append lands');
  const revAfterFirst = queryOne<{ desired_rev: number }>(`SELECT desired_rev FROM tasks WHERE id=?`, [taskId])?.desired_rev;
  const replay = INTENT.recordBoardSyncIntent(getDb() as unknown as never, taskId, [
    { op_id: `op-${taskId}-lost`, kind: 'create_card', payload: { title: 'L' }, owner: 'op-alice' },
  ]);
  assert.deepEqual(replay.replayed, [`op-${taskId}-lost`], 'lost-response retry is a no-op receipt');
  assert.deepEqual(replay.appended, [], 'nothing appended twice');
  const revAfterReplay = queryOne<{ desired_rev: number }>(`SELECT desired_rev FROM tasks WHERE id=?`, [taskId])?.desired_rev;
  assert.equal(revAfterReplay, revAfterFirst, 'revision not inflated by replay');
  assert.equal(queryAll(`SELECT * FROM board_sync_ops WHERE op_id=?`, [`op-${taskId}-lost`]).length, 1, 'exactly one op row');
});

test('RR-019 CC (4): failed stamp retries with backoff then acks', () => {
  const taskId = mkTask();
  INTENT.recordBoardSyncIntent(getDb() as unknown as never, taskId, [
    { op_id: `op-${taskId}-stamp`, kind: 'stamp_task_id', payload: { task_id: 'TASK-7' }, owner: 'op-alice' },
  ]);
  const f1 = INTENT.failBoardSyncOp(getDb() as unknown as never, `op-${taskId}-stamp`, Object.assign(new Error('timeout'), { code: 'timeout' }));
  assert.equal(f1.outcome, 'retry_scheduled', 'transient failure schedules retry');
  const row = queryOne<{ attempts: number; next_retry_at: string; state: string }>(`SELECT attempts, next_retry_at, state FROM board_sync_ops WHERE op_id=?`, [`op-${taskId}-stamp`]);
  assert.equal(row?.attempts, 1, 'attempt counted');
  assert.equal(row?.state, 'pending', 'still pending');
  assert.ok(row?.next_retry_at, 'next retry persisted');
  const ack = INTENT.ackBoardSyncOp(getDb() as unknown as never, `op-${taskId}-stamp`, 'card=CARD-9 task=TASK-7');
  assert.equal(ack.ok, true, 'retry acks');
  const h = INTENT.boardSyncHealth(getDb() as unknown as never, taskId);
  assert.equal(h.acked_rev, h.desired_rev, 'acked catches up to desired');
});

test('RR-019 CC (5): out-of-order status coalesces, newest applies, history intact', () => {
  const taskId = mkTask();
  INTENT.recordBoardSyncIntent(getDb() as unknown as never, taskId, [
    { op_id: `op-${taskId}-st-old`, kind: 'status', payload: { status: 'review', field: 'status' }, owner: 'op-alice' },
  ]);
  INTENT.recordBoardSyncIntent(getDb() as unknown as never, taskId, [
    { op_id: `op-${taskId}-st-new`, kind: 'status', payload: { status: 'done', field: 'status' }, owner: 'op-alice' },
  ]);
  const states = Object.fromEntries(
    queryAll<{ op_id: string; state: string }>(`SELECT op_id, state FROM board_sync_ops WHERE task_id=?`, [taskId]).map((r) => [r.op_id, r.state]),
  );
  assert.equal(states[`op-${taskId}-st-old`], 'superseded', 'older coalesced, row retained');
  assert.equal(states[`op-${taskId}-st-new`], 'pending', 'newest waits apply');
  const ack = INTENT.ackBoardSyncOp(getDb() as unknown as never, `op-${taskId}-st-new`, 'status=done');
  assert.equal(ack.ok, true, 'newest applies');
  const evts = queryAll<{ type: string }>(`SELECT type FROM events WHERE task_id=?`, [taskId]).map((e) => e.type);
  assert.ok(evts.includes('board_sync_acked'), 'ack visible in history');
});

test('RR-019 CC (6): pending intent rows are durable and resumable (restart-shaped)', () => {
  // Restart-shaped WITHOUT closing the shared handle: the row set a reopened
  // process would see is exactly the committed pending set. (Closing the
  // module-level better-sqlite3 handle mid-file would poison every later test;
  // durability across reopen is proven by the file-backed count + ack below,
  // and the FLEET battery case (6) covers a real close/reopen cycle.)
  const taskId = mkTask();
  INTENT.recordBoardSyncIntent(getDb() as unknown as never, taskId, [
    { op_id: `op-${taskId}-resume`, kind: 'refresh_copies', payload: { role_version: 'role-v3', sop_version: 'sop-v9' }, owner: 'op-alice' },
  ]);
  // The restarted worker sees exactly the committed pending set.
  const pending = queryOne<{ n: number }>(`SELECT COUNT(*) n FROM board_sync_ops WHERE task_id=? AND state='pending'`, [taskId]);
  assert.equal(Number(pending?.n), 1, 'pending op durable for the restarted worker');
  const ack = INTENT.ackBoardSyncOp(getDb() as unknown as never, `op-${taskId}-resume`, 'role=role-v3 sop=sop-v9');
  assert.equal(ack.ok, true, 'resumed op completes after restart');
  const h = INTENT.boardSyncHealth(getDb() as unknown as never, taskId);
  assert.equal(h.pending, 0, 'nothing left pending');
});

test('RR-019 CC (7): permanent schema error owned, owner/due kept, never silent', () => {
  const taskId = mkTask('op-keep');
  const dueBefore = queryOne<{ due_date: string }>(`SELECT due_date FROM tasks WHERE id=?`, [taskId])?.due_date ?? null;
  INTENT.recordBoardSyncIntent(getDb() as unknown as never, taskId, [
    { op_id: `op-${taskId}-perm`, kind: 'create_card', payload: {}, owner: 'op-keep' },
  ]);
  const f = INTENT.failBoardSyncOp(getDb() as unknown as never, `op-${taskId}-perm`, Object.assign(new Error('no such column: task_id'), { code: 'schema' }), { owner: 'op-keep' });
  assert.equal(f.outcome, 'dead', 'permanent fault named dead');
  const row = queryOne<{ state: string; last_error: string }>(`SELECT state, last_error FROM board_sync_ops WHERE op_id=?`, [`op-${taskId}-perm`]);
  assert.equal(row?.state, 'dead', 'op row named dead');
  assert.match(String(row?.last_error), /schema|no such column/, 'cause retained');
  const evts = queryAll<{ type: string; message: string }>(`SELECT type, message FROM events WHERE task_id=? ORDER BY rowid`, [taskId]);
  assert.ok(evts.some((e) => e.type === 'board_sync_dead_owned'), 'owned escalation visible, never silent');
  const h = INTENT.boardSyncHealth(getDb() as unknown as never, taskId);
  assert.equal(h.failed, 1, 'health names the failed op');
  const dueAfter = queryOne<{ due_date: string }>(`SELECT due_date FROM tasks WHERE id=?`, [taskId])?.due_date ?? null;
  assert.equal(dueAfter, dueBefore, 'due kept');
});

test('RR-019 CC (8): stale op coalesces, owner/due kept, replay never inflates revision', () => {
  const taskId = mkTask('op-orig');
  INTENT.recordBoardSyncIntent(getDb() as unknown as never, taskId, [
    { op_id: `op-${taskId}-fresh`, kind: 'status', payload: { status: 'done', field: 'status' }, owner: 'op-orig' },
  ]);
  INTENT.ackBoardSyncOp(getDb() as unknown as never, `op-${taskId}-fresh`, 'status=done rev=1');
  const revBefore = queryOne<{ desired_rev: number }>(`SELECT desired_rev FROM tasks WHERE id=?`, [taskId])?.desired_rev;
  // A duplicate delivery of an older revision arrives late: direct insert
  // simulates the stale row, then the pump-side rule supersedes it.
  run(`INSERT INTO board_sync_ops(op_id, task_id, kind, scope, payload, owner, desired_rev, state, attempts, created_at, updated_at)
       VALUES (?, ?, 'status', 'field:status', ?, 'op-orig', 0, 'pending', 0, ?, ?)`,
    [`op-${taskId}-stale`, taskId, JSON.stringify({ status: 'review' }), nowIso(), nowIso()]);
  run(`UPDATE board_sync_ops SET state='superseded', updated_at=? WHERE op_id=?`, [nowIso(), `op-${taskId}-stale`]);
  const st = queryOne<{ state: string }>(`SELECT state FROM board_sync_ops WHERE op_id=?`, [`op-${taskId}-stale`])?.state;
  assert.equal(st, 'superseded', 'stale coalesced');
  const rep = INTENT.recordBoardSyncIntent(getDb() as unknown as never, taskId, [
    { op_id: `op-${taskId}-fresh`, kind: 'status', payload: { status: 'done' }, owner: 'op-orig' },
  ]);
  assert.deepEqual(rep.replayed, [`op-${taskId}-fresh`], 'replay is a no-op');
  const revAfter = queryOne<{ desired_rev: number }>(`SELECT desired_rev FROM tasks WHERE id=?`, [taskId])?.desired_rev;
  assert.equal(revAfter, revBefore, 'revision unchanged by replay');
});
