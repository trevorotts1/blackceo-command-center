/**
 * U38 / C-07 — S3 closure: the human-promote control for parked review
 * cards. This test covers the CODE leg of C-07 sub-item (2) (master spec v2
 * `skill6-blended-persona-kanban-MASTER-SPEC-v2-2026-07-13.md` §C+I.2). The
 * LIVE leg — sub-item (1), an operator-box proof run of the three
 * review-lane nets — is a separate, owed operator-box run and is NOT
 * simulated or claimed here.
 *
 * Verifies the unit's BINARY acceptance criteria (b) and (c):
 *   (b) the promote button/route is scoped ONLY to a review card the QC
 *       heuristic fallback parked ([QC-HEURISTIC] / [QC-HEURISTIC-FINAL] —
 *       NEVER an LLM-scored review card, NEVER any other status), and a
 *       successful promote lands the task `done` with a `task_events` row
 *       `actor='operator'`.
 *   (c) a concurrent/stale status assumption makes the promote fail loudly
 *       (CAS_CONFLICT / 403, never a silent overwrite) — see the two-test
 *       strategy note above the CAS_CONFLICT section below for why this is
 *       proven at both the `transition()` layer AND the route layer.
 *
 * Uses an isolated temp DB, same pattern as the sibling U37/C-06 contract
 * test this unit sits beside (tests/unit/u37-c-06-dispatch-hold-contract.test.ts)
 * and the status-route test (tests/unit/task-status-transition.test.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u38-qc-promote-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type TasksRouteModule = typeof import('../../src/app/api/tasks/route');
let tasksGET: TasksRouteModule['GET'];

type TaskByIdRouteModule = typeof import('../../src/app/api/tasks/[id]/route');
let taskByIdGET: TaskByIdRouteModule['GET'];

type PromoteRouteModule = typeof import('../../src/app/api/tasks/[id]/promote/route');
let promotePOST: PromoteRouteModule['POST'];

type QcPromoteModule = typeof import('../../src/lib/qc-promote');
let getQcHeuristicPark: QcPromoteModule['getQcHeuristicPark'];

type LifecycleModule = typeof import('../../src/lib/task-lifecycle');
let transition: LifecycleModule['transition'];
let TransitionError: LifecycleModule['TransitionError'];

let taskCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++taskCounter}-${Date.now()}`;
}

function insertTask(id: string, status: string) {
  const now = new Date().toISOString();
  // workspace_id/business_id NULL — same fixture pattern as the sibling
  // U37/C-06 test (insertTask): NULL sidesteps the workspaces(id) foreign key
  // (PRAGMA foreign_keys = ON, src/lib/db/index.ts:108) without needing a
  // seeded workspace row.
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, ?, 'medium', NULL, NULL, ?, ?)`,
    [id, `Fixture task ${id}`, status, now, now],
  );
}

function insertQcReviewEvent(taskId: string, message: string, createdAt: string) {
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'qc_review', ?, ?, ?)`,
    [`evt-${taskId}-${createdAt}-${Math.random().toString(36).slice(2, 6)}`, taskId, message, createdAt],
  );
}

function currentStatus(id: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

function taskEventsFor(id: string) {
  return queryOne<{ n: number; actor: string | null }>(
    `SELECT COUNT(*) AS n, MAX(actor) AS actor FROM task_events WHERE task_id = ? AND to_status = 'done'`,
    [id],
  );
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // trigger full migration chain against the temp DB

  const tasksRoute = await import('../../src/app/api/tasks/route');
  tasksGET = tasksRoute.GET;

  const taskByIdRoute = await import('../../src/app/api/tasks/[id]/route');
  taskByIdGET = taskByIdRoute.GET;

  const promoteRoute = await import('../../src/app/api/tasks/[id]/promote/route');
  promotePOST = promoteRoute.POST;

  const qp = await import('../../src/lib/qc-promote');
  getQcHeuristicPark = qp.getQcHeuristicPark;

  const lifecycle = await import('../../src/lib/task-lifecycle');
  transition = lifecycle.transition;
  TransitionError = lifecycle.TransitionError;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function getBoardRow(taskId: string) {
  return (async () => {
    const req = new NextRequest('http://localhost/api/tasks');
    const res = await tasksGET(req);
    assert.equal(res.status, 200);
    const board = await res.json();
    return board.find((t: { id: string }) => t.id === taskId);
  })();
}

function getSingleTask(taskId: string) {
  const req = new NextRequest(`http://localhost/api/tasks/${taskId}`);
  return taskByIdGET(req, { params: Promise.resolve({ id: taskId }) }).then((r) => r.json());
}

function callPromote(taskId: string) {
  const req = new NextRequest(`http://localhost/api/tasks/${taskId}/promote`, { method: 'POST' });
  return promotePOST(req, { params: Promise.resolve({ id: taskId }) });
}

// ─── (a) getQcHeuristicPark read-path — direct unit coverage ───────────────

test('[U38-a] getQcHeuristicPark returns QC-HEURISTIC for a first-pass no-key heuristic event', () => {
  const taskId = nextId('lib-heuristic');
  insertTask(taskId, 'review');
  insertQcReviewEvent(
    taskId,
    '[QC-HEURISTIC] Score: 7.0/10 | QC ran in heuristic mode (no LLM key); human review required (pass 1/3). [path:heuristic]',
    '2026-07-15T10:00:00.000Z',
  );

  const park = getQcHeuristicPark(taskId);
  assert.ok(park);
  assert.equal(park!.marker, 'QC-HEURISTIC');
  assert.match(park!.message, /human review required/);
});

test('[U38-a] getQcHeuristicPark returns QC-HEURISTIC-FINAL for a terminal-escalation event', () => {
  const taskId = nextId('lib-final');
  insertTask(taskId, 'review');
  insertQcReviewEvent(
    taskId,
    '[QC-HEURISTIC] Score: 7.0/10 | QC ran in heuristic mode (pass 1/3).',
    '2026-07-15T09:00:00.000Z',
  );
  insertQcReviewEvent(
    taskId,
    '[QC-HEURISTIC-FINAL] Score: 7.0/10 | QC ran in heuristic mode 3 time(s) with NO client Ollama Cloud judge configured — MANUAL REVIEW REQUIRED.',
    '2026-07-15T10:00:00.000Z',
  );

  const park = getQcHeuristicPark(taskId);
  assert.ok(park);
  assert.equal(park!.marker, 'QC-HEURISTIC-FINAL');
  assert.match(park!.message, /MANUAL REVIEW REQUIRED/);
});

test('[U38-a] getQcHeuristicPark returns null for a task with no qc_review events at all', () => {
  const taskId = nextId('lib-none');
  insertTask(taskId, 'review');
  assert.equal(getQcHeuristicPark(taskId), null);
});

test('[U38-a] getQcHeuristicPark returns null when the NEWEST qc_review event is [QC-AUTO] (LLM-scored), even with an OLDER heuristic pass in history', () => {
  const taskId = nextId('lib-llm-latest');
  insertTask(taskId, 'review');
  insertQcReviewEvent(
    taskId,
    '[QC-HEURISTIC] Score: 6.0/10 | QC ran in heuristic mode (pass 1/3).',
    '2026-07-15T09:00:00.000Z',
  );
  // The box gained an LLM/judge key and was re-scored — the newest event is
  // now an LLM pass. A superseded heuristic marker in history must never
  // resurrect the promote control (same "latest wins" discipline as the
  // sibling U37 dispatch-hold read-path).
  insertQcReviewEvent(
    taskId,
    '[QC-AUTO] Score: 6.2/10 | FAIL → returned to Backlog for re-route | [path:llm]',
    '2026-07-15T10:00:00.000Z',
  );

  assert.equal(getQcHeuristicPark(taskId), null);
});

test('[U38-a] getQcHeuristicPark returns null when the NEWEST qc_review event is [QC-DEFERRED-PROVIDER-DOWN]', () => {
  const taskId = nextId('lib-deferred');
  insertTask(taskId, 'review');
  insertQcReviewEvent(
    taskId,
    '[QC-DEFERRED-PROVIDER-DOWN] Score: 5.0/10 | QC scorer provider is down — holding in review and auto-rescoring when it returns (NOT human-required).',
    '2026-07-15T10:00:00.000Z',
  );

  assert.equal(getQcHeuristicPark(taskId), null, 'provider-down deferral is NOT human-required and must never render the promote control');
});

// ─── (a)/(b) tasks GET routes attach qc_heuristic_park, scoped correctly ────

test('[U38-a] a heuristic-parked review task carries qc_heuristic_park on BOTH the board GET and the single-task GET', async () => {
  const taskId = nextId('parked-both-gets');
  insertTask(taskId, 'review');
  insertQcReviewEvent(
    taskId,
    '[QC-HEURISTIC] Score: 7.0/10 | QC ran in heuristic mode (no LLM key); human review required (pass 1/3).',
    '2026-07-15T10:00:00.000Z',
  );

  const row = await getBoardRow(taskId);
  assert.ok(row, 'task must be on the board');
  assert.ok(row.qc_heuristic_park, 'board row must carry qc_heuristic_park');
  assert.equal(row.qc_heuristic_park.marker, 'QC-HEURISTIC');

  const single = await getSingleTask(taskId);
  assert.ok(single.qc_heuristic_park, 'single-task GET must carry qc_heuristic_park');
  assert.equal(single.qc_heuristic_park.marker, 'QC-HEURISTIC');
});

test('[U38-b] an LLM-scored review task (latest qc_review is [QC-AUTO]) never carries qc_heuristic_park — never for LLM-scored cards', async () => {
  const taskId = nextId('llm-scored-review');
  insertTask(taskId, 'review');
  insertQcReviewEvent(
    taskId,
    '[QC-AUTO] Score: 9.1/10 | PASS → owner-approval pending | [path:llm]',
    '2026-07-15T10:00:00.000Z',
  );

  const row = await getBoardRow(taskId);
  assert.equal(row.qc_heuristic_park, null);
  const single = await getSingleTask(taskId);
  assert.equal(single.qc_heuristic_park, null);
});

test('[U38-b] a task with a heuristic-parked history that is NOT currently review never carries qc_heuristic_park — never for other statuses', async () => {
  const taskId = nextId('parked-but-blocked');
  insertTask(taskId, 'blocked');
  // Even though a heuristic marker exists in this task's qc_review history
  // (e.g. it was parked in review, then separately escalated to blocked for
  // an unrelated human-decision reason), the field must be null because the
  // task is not currently 'review' — short-circuited at the tasks GET layer,
  // not merely at the panel's render gate.
  insertQcReviewEvent(
    taskId,
    '[QC-HEURISTIC] Score: 6.0/10 | QC ran in heuristic mode (pass 1/3).',
    '2026-07-15T10:00:00.000Z',
  );

  const row = await getBoardRow(taskId);
  assert.equal(row.qc_heuristic_park, null);
  const single = await getSingleTask(taskId);
  assert.equal(single.qc_heuristic_park, null);
});

test('[U38-b] a plain in_progress task with no qc_review history never carries qc_heuristic_park', async () => {
  const taskId = nextId('plain-in-progress');
  insertTask(taskId, 'in_progress');

  const row = await getBoardRow(taskId);
  assert.equal(row.qc_heuristic_park, null);
});

// ─── (b) POST /api/tasks/[id]/promote — scope + success + audit ────────────

test('[U38-b] promote on a heuristic-parked review task (QC-HEURISTIC) succeeds: 200, status=done, task_events actor=operator', async () => {
  const taskId = nextId('promote-happy-heuristic');
  insertTask(taskId, 'review');
  insertQcReviewEvent(
    taskId,
    '[QC-HEURISTIC] Score: 7.0/10 | QC ran in heuristic mode (no LLM key); human review required (pass 1/3).',
    '2026-07-15T10:00:00.000Z',
  );

  const res = await callPromote(taskId);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'done');
  assert.equal(currentStatus(taskId), 'done', 'DB row must be persisted as done');

  const evt = taskEventsFor(taskId);
  assert.ok((evt?.n ?? 0) >= 1, 'a task_events row to_status=done must be written');
  assert.equal(evt?.actor, 'operator', "the audit row's actor must be the literal string 'operator'");
});

test('[U38-b] promote on a heuristic-parked review task (QC-HEURISTIC-FINAL) succeeds: 200, status=done', async () => {
  const taskId = nextId('promote-happy-final');
  insertTask(taskId, 'review');
  insertQcReviewEvent(
    taskId,
    '[QC-HEURISTIC-FINAL] Score: 7.0/10 | QC ran in heuristic mode 3 time(s) — MANUAL REVIEW REQUIRED.',
    '2026-07-15T10:00:00.000Z',
  );

  const res = await callPromote(taskId);
  assert.equal(res.status, 200);
  assert.equal(currentStatus(taskId), 'done');
  const evt = taskEventsFor(taskId);
  assert.equal(evt?.actor, 'operator');
});

test('[U38-b] promote on a non-review status (e.g. in_progress) is refused with 403 and no mutation', async () => {
  const taskId = nextId('promote-wrong-status');
  insertTask(taskId, 'in_progress');

  const res = await callPromote(taskId);
  assert.equal(res.status, 403);
  assert.equal(currentStatus(taskId), 'in_progress', 'status must NOT change');
});

test('[U38-b] promote on an LLM-scored review task ([QC-AUTO] latest) is refused with 403 and no mutation — never promotes an LLM-scored card', async () => {
  const taskId = nextId('promote-llm-scored');
  insertTask(taskId, 'review');
  insertQcReviewEvent(
    taskId,
    '[QC-AUTO] Score: 9.1/10 | PASS → owner-approval pending | [path:llm]',
    '2026-07-15T10:00:00.000Z',
  );

  const res = await callPromote(taskId);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /heuristic-parked/);
  assert.equal(currentStatus(taskId), 'review', 'status must NOT change');
});

test('[U38-b] promote on a review task with NO qc_review event at all is refused with 403 and no mutation', async () => {
  const taskId = nextId('promote-no-review-event');
  insertTask(taskId, 'review');

  const res = await callPromote(taskId);
  assert.equal(res.status, 403);
  assert.equal(currentStatus(taskId), 'review');
});

test('[U38-b] promote on an unknown task id returns 404', async () => {
  const res = await callPromote(`missing-${nextId('x')}`);
  assert.equal(res.status, 404);
});

// ─── (c) CAS_CONFLICT — a stale/concurrent status assumption fails LOUDLY ──
//
// This codebase's DB layer (better-sqlite3) is fully synchronous, so within
// ONE test process there is no yield point between this route's own
// existing.status/getQcHeuristicPark guard reads and its transition() call —
// a genuinely CONCURRENT writer racing that exact window can only occur
// cross-process (two server instances hitting the same row), which is
// exactly what transition()'s expectedFrom compare-and-swap protects
// against and exactly the call this route makes. So CAS_CONFLICT is proven
// at two levels: (1) directly against transition() with the EXACT evidence
// object this route passes, proving the underlying guarantee fires and
// writes NOTHING when the 'review' assumption is stale; (2) at the route
// level, proving that a task which left 'review' by the time of the request
// is independently re-verified and refused — never a silent promote — which
// is the SAME "fail loudly, not a silent overwrite" contract expressed at
// the layer this single-process test CAN reach.

test('[U38-c] transition() itself refuses a stale review assumption with CAS_CONFLICT and writes nothing (the exact call this route makes)', async () => {
  const taskId = nextId('cas-direct');
  // Seeded as 'blocked' — simulating "another writer already moved this task
  // out of review by the time the promote call executes".
  insertTask(taskId, 'blocked');

  await assert.rejects(
    () =>
      transition(taskId, 'done', {
        actor: 'operator',
        operatorOverride: true,
        expectedFrom: 'review',
      }),
    (err: unknown) => {
      assert.ok(err instanceof TransitionError, 'must throw TransitionError');
      assert.equal((err as InstanceType<typeof TransitionError>).code, 'CAS_CONFLICT');
      return true;
    },
  );

  assert.equal(currentStatus(taskId), 'blocked', 'status must remain UNCHANGED — never silently forced to done');
  const evt = taskEventsFor(taskId);
  assert.equal(evt?.n ?? 0, 0, 'no task_events done row may be written on a CAS conflict');
});

test('[U38-c] the promote route independently re-verifies scope against CURRENT state — a task that left review before the request is refused, never silently promoted', async () => {
  const taskId = nextId('cas-route-stale');
  insertTask(taskId, 'review');
  insertQcReviewEvent(
    taskId,
    '[QC-HEURISTIC] Score: 7.0/10 | QC ran in heuristic mode (pass 1/3).',
    '2026-07-15T10:00:00.000Z',
  );

  // Simulate "a concurrent writer already moved this card out of review"
  // BEFORE this request reaches the route (e.g. another operator/agent acted
  // first) — a direct raw write, standing in for the other writer.
  run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', [
    'blocked',
    new Date().toISOString(),
    taskId,
  ]);

  const res = await callPromote(taskId);
  assert.notEqual(res.status, 200, 'a stale promote attempt must never succeed');
  assert.equal(res.status, 403);
  assert.equal(currentStatus(taskId), 'blocked', 'status must remain exactly what the concurrent writer set — never silently overwritten to done');
  const evt = taskEventsFor(taskId);
  assert.equal(evt?.n ?? 0, 0, 'no task_events done row may be written when the promote is refused');
});
