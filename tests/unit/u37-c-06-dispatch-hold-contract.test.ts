/**
 * U37 / C-06 — S2 class-b visibility: "routed but not runnable" must be
 * visible ON THE CARD, not only in events.
 *
 * Verifies the unit's BINARY acceptance criteria (master spec
 * `skill6-blended-persona-kanban-MASTER-SPEC-v2-2026-07-13.md` §C+I.2 C-06):
 *   (a) a fixture task held by a missing runtime renders the chip data (the
 *       tasks GET board row carries `dispatch_hold`) AND the task-detail GET
 *       carries the same field with the hold text.
 *   (b) the same task, after the runtime is wired and one dispatch succeeds
 *       (a later `status_changed` activity superseding the hold), shows NO
 *       chip — the read-path derives from the LATEST activity, not history.
 *   (c) no chip ever renders for a task with no such activity row (either
 *       zero activities at all, or activities whose latest row is some other
 *       type).
 *
 * Uses an isolated temp DB, exactly like the sibling U20/B-U6 persona-
 * mismatch contract test this unit sits beside
 * (tests/unit/u20-b-u6-persona-mismatch-contract.test.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u37-dispatch-hold-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type TasksRouteModule = typeof import('../../src/app/api/tasks/route');
let tasksGET: TasksRouteModule['GET'];

type TaskByIdRouteModule = typeof import('../../src/app/api/tasks/[id]/route');
let taskByIdGET: TaskByIdRouteModule['GET'];

type DispatchHoldModule = typeof import('../../src/lib/dispatch-hold');
let getOpenDispatchHold: DispatchHoldModule['getOpenDispatchHold'];
let DISPATCH_HOLD_ACTIVITY_TYPE: DispatchHoldModule['DISPATCH_HOLD_ACTIVITY_TYPE'];

let taskCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++taskCounter}-${Date.now()}`;
}

function insertTask(id: string, agentId: string | null = null) {
  const now = new Date().toISOString();
  // workspace_id/business_id NULL — same fixture pattern as the sibling U20
  // test (insertBlendedTask): NULL sidesteps the workspaces(id) foreign key
  // (PRAGMA foreign_keys = ON, src/lib/db/index.ts:108) without needing a
  // seeded workspace row; the class-b hold's OWN workspace_id lives in the
  // activity metadata below, unrelated to this FK.
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, ?, 'assigned', 'medium', NULL, NULL, ?, ?, ?)`,
    [id, `Fixture task ${id}`, agentId, now, now],
  );
}

function insertAgent(id: string) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO agents (id, name, role, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, 'specialist', 'standby', NULL, ?, ?)`,
    [id, `Agent ${id}`, now, now],
  );
}

/** Mirrors the EXACT insert task-dispatcher.ts's RESOLVER-DISPATCH gate does
 * on a class-b hold (task-dispatcher.ts:1056-1068) — same activity_type,
 * same metadata shape, so this fixture is faithful to the real write path. */
function insertHoldActivity(taskId: string, agentId: string, createdAt: string, message?: string) {
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      `act-${taskId}-hold-${createdAt}`,
      taskId,
      agentId,
      DISPATCH_HOLD_ACTIVITY_TYPE,
      message ??
        `[routed_but_not_dispatched] Task "Fixture task ${taskId}" (${taskId}) routed to "Agent ${agentId}" ` +
          `but NO per-department OpenClaw runtime exists (~/.openclaw/agents/<dept-slug>/ missing; ` +
          `workspace_id=ws-dept-1, role=none). Dispatch HELD to avoid the agent:main re-ingest loop. ` +
          `Wire the department runtime to release.`,
      JSON.stringify({ workspace_id: 'ws-dept-1', role: null, reason: 'no_specialist_runtime' }),
      createdAt,
    ],
  );
}

/** A later, unrelated activity (e.g. a successful dispatch's status_changed
 * row) that supersedes the hold as the task's newest activity. */
function insertLaterActivity(taskId: string, agentId: string, createdAt: string, activityType = 'status_changed') {
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [`act-${taskId}-later-${createdAt}`, taskId, agentId, activityType, `Task auto-dispatched to Agent ${agentId}`, createdAt],
  );
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // trigger full migration chain against the temp DB

  const tasksRoute = await import('../../src/app/api/tasks/route');
  tasksGET = tasksRoute.GET;

  const taskByIdRoute = await import('../../src/app/api/tasks/[id]/route');
  taskByIdGET = taskByIdRoute.GET;

  const dh = await import('../../src/lib/dispatch-hold');
  getOpenDispatchHold = dh.getOpenDispatchHold;
  DISPATCH_HOLD_ACTIVITY_TYPE = dh.DISPATCH_HOLD_ACTIVITY_TYPE;
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

// ─── (a) fixture task held by a missing runtime -> chip data on both GETs ──

test('[U37-a] a task held by a missing runtime carries dispatch_hold on the tasks-list GET board row', async () => {
  const taskId = nextId('held');
  const agentId = nextId('agent');
  insertAgent(agentId);
  insertTask(taskId, agentId);
  insertHoldActivity(taskId, agentId, '2026-07-15T10:00:00.000Z');

  const row = await getBoardRow(taskId);
  assert.ok(row, 'task must be on the board');
  assert.ok(row.dispatch_hold, 'the board row must carry dispatch_hold (the chip source)');
  assert.match(row.dispatch_hold.message, /Wire the department runtime to release/);
  assert.equal(row.dispatch_hold.reason, 'no_specialist_runtime');
  assert.equal(row.dispatch_hold.workspace_id, 'ws-dept-1');
});

test('[U37-a] the SAME task carries dispatch_hold with the hold text on the single-task GET (task-detail modal source)', async () => {
  const taskId = nextId('held-detail');
  const agentId = nextId('agent');
  insertAgent(agentId);
  insertTask(taskId, agentId);
  insertHoldActivity(taskId, agentId, '2026-07-15T10:00:00.000Z');

  const single = await getSingleTask(taskId);
  assert.ok(single.dispatch_hold, 'the single-task GET must carry dispatch_hold');
  assert.match(single.dispatch_hold.message, /Dispatch HELD to avoid the agent:main re-ingest loop/);
});

test('[U37-a] getOpenDispatchHold returns the verbatim message + structured metadata', () => {
  const taskId = nextId('lib-direct');
  const agentId = nextId('agent');
  insertAgent(agentId);
  insertTask(taskId, agentId);
  insertHoldActivity(taskId, agentId, '2026-07-15T10:00:00.000Z');

  const hold = getOpenDispatchHold(taskId);
  assert.ok(hold);
  assert.match(hold!.message, /routed_but_not_dispatched/);
  assert.equal(hold!.reason, 'no_specialist_runtime');
});

// ─── (b) after the runtime is wired + one dispatch succeeds -> NO chip ─────

test('[U37-b] after a later successful-dispatch activity, dispatch_hold clears — derived from latest activity, not history', async () => {
  const taskId = nextId('healed');
  const agentId = nextId('agent');
  insertAgent(agentId);
  insertTask(taskId, agentId);
  insertHoldActivity(taskId, agentId, '2026-07-15T10:00:00.000Z');

  // Pre-heal: chip is present.
  assert.ok(getOpenDispatchHold(taskId), 'chip must be present before the runtime is wired');

  // The runtime gets wired; the next dispatch attempt succeeds and writes a
  // LATER status_changed activity (the exact activity_type task-dispatcher.ts
  // inserts on a successful auto-dispatch).
  insertLaterActivity(taskId, agentId, '2026-07-15T10:05:00.000Z', 'status_changed');

  const hold = getOpenDispatchHold(taskId);
  assert.equal(hold, null, 'dispatch_hold must clear once a later activity supersedes the hold');

  const row = await getBoardRow(taskId);
  assert.equal(row.dispatch_hold, null, 'board row must show NO chip after the successful dispatch');
});

// ─── (c) no chip ever renders for a task without such an activity row ─────

test('[U37-c] a task with ZERO activities never carries dispatch_hold', async () => {
  const taskId = nextId('no-activity');
  insertTask(taskId, null);

  assert.equal(getOpenDispatchHold(taskId), null);
  const row = await getBoardRow(taskId);
  assert.equal(row.dispatch_hold, null);
});

test('[U37-c] a task whose latest activity is a DIFFERENT type never carries dispatch_hold, even with an older hold in its history', async () => {
  const taskId = nextId('unrelated-latest');
  const agentId = nextId('agent');
  insertAgent(agentId);
  insertTask(taskId, agentId);
  // An OLDER hold exists in history...
  insertHoldActivity(taskId, agentId, '2026-07-15T09:00:00.000Z');
  // ...but the NEWEST activity is unrelated (e.g. a manual comment/update).
  insertLaterActivity(taskId, agentId, '2026-07-15T09:30:00.000Z', 'updated');

  assert.equal(getOpenDispatchHold(taskId), null, 'a superseded hold in history must never resurrect the chip');
});

test('[U37-c] a normally-dispatched task (no hold ever) never carries dispatch_hold', async () => {
  const taskId = nextId('normal');
  const agentId = nextId('agent');
  insertAgent(agentId);
  insertTask(taskId, agentId);
  insertLaterActivity(taskId, agentId, '2026-07-15T10:00:00.000Z', 'status_changed');

  const row = await getBoardRow(taskId);
  assert.equal(row.dispatch_hold, null);
});
