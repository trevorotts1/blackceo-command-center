/**
 * raw-status-writer-audit-fixture.test.ts — U99 (v1 U9; v1 ref C12.3 item 1;
 * master spec Section E4), acceptance criterion (c): "every migrated path's
 * existing tests stay green and `task_events` rows appear for transitions
 * that previously bypassed auditing (fixture diff)."
 *
 * scripts/guard-raw-status-writers.ts (see raw-status-writer-guard.test.ts)
 * proves the STATIC half — every raw writer is enumerated and annotated. This
 * file proves the BEHAVIORAL half on two representative call sites that had
 * ZERO task_events coverage before U99 (verified by reading the pre-U99 code:
 * neither wrote to `task_events`, only a generic `task_activities`/`events`
 * row or nothing at all):
 *
 *   1. POST /api/tasks/[id]/planning/approve — planning → backlog. Before
 *      U99 this route wrote a `task_activities` row but NO `task_events` row.
 *   2. blockForOwnerConfirm() (src/lib/tasks.ts) — the A-U4/D23 hard-hold
 *      path. Before U99 this wrote `events` + notifySystem but NO
 *      `task_events` row.
 *
 * Both are now audited via recordStatusEvent() immediately after their raw
 * UPDATE. This file seeds a fixture task per case, drives the real code path,
 * and asserts the `task_events` row now exists with the correct
 * from_status/to_status — the "fixture diff" the acceptance criterion calls
 * for.
 *
 *   node --import tsx --test tests/unit/raw-status-writer-audit-fixture.test.ts
 *   (or: npm run test:unit, which globs this file in automatically)
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';

import './_isolated-db'; // MUST precede any '@/lib/db' import: throwaway DATABASE_PATH.

type DbModule = typeof import('../../src/lib/db');
type ApproveRouteModule = typeof import('../../src/app/api/tasks/[id]/planning/approve/route');
type TasksModule = typeof import('../../src/lib/tasks');

let db: DbModule;
let approveRoute: ApproveRouteModule;
let tasksLib: TasksModule;

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb(); // runs the full migration chain against the isolated DB
  approveRoute = await import('../../src/app/api/tasks/[id]/planning/approve/route');
  tasksLib = await import('../../src/lib/tasks');
});

test.after(() => {
  try { db.closeDb(); } catch { /* best-effort */ }
});

let runId = 0;
function nextId(prefix: string): string {
  runId += 1;
  return `${prefix}-${runId}-${uuidv4()}`;
}

function seedWorkspace(): string {
  const now = new Date().toISOString();
  const wsId = nextId('ws');
  db.run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, 'U99 Fixture', '🧪', 'default', 1, ?, ?)`,
    [wsId, `u99-fixture-${wsId}`, now, now],
  );
  return wsId;
}

function taskEventsFor(taskId: string): Array<{ from_status: string; to_status: string; actor: string | null; reason: string | null }> {
  return db.queryAll(
    `SELECT from_status, to_status, actor, reason FROM task_events WHERE task_id = ? ORDER BY created_at ASC`,
    [taskId],
  );
}

// ============================================================================
// CASE 1 — POST /api/tasks/[id]/planning/approve (planning → backlog)
// ============================================================================

test('[FIXTURE] planning/approve: task_events row now appears for planning→backlog (previously bypassed auditing)', async () => {
  const wsId = seedWorkspace();
  const taskId = nextId('task-approve');
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'U99 planning-approve fixture', 'Original brief.', 'planning', 'high', ?, 'default', ?, ?)`,
    [taskId, wsId, now, now],
  );

  const questionId = nextId('pq');
  db.run(
    `INSERT INTO planning_questions (id, task_id, category, question, question_type, answer, sort_order, created_at)
     VALUES (?, ?, 'goal', 'What is the goal?', 'text', 'Ship the fixture.', 0, ?)`,
    [questionId, taskId, now],
  );

  // Precondition: zero task_events rows before the route runs.
  assert.equal(taskEventsFor(taskId).length, 0, 'no task_events rows should exist before the route runs');

  const res = (await approveRoute.POST(
    new NextRequest(`http://localhost/api/tasks/${taskId}/planning/approve`, { method: 'POST' }),
    { params: Promise.resolve({ id: taskId }) },
  )) as unknown as Response;

  assert.equal(res.status, 200, 'approve route must succeed');

  const row = db.queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(row?.status, 'backlog', 'task must be moved to backlog');

  const events = taskEventsFor(taskId);
  assert.equal(events.length, 1, 'exactly one task_events row must now be written (the U99 gap this closes)');
  assert.equal(events[0].from_status, 'planning');
  assert.equal(events[0].to_status, 'backlog');
});

// ============================================================================
// CASE 2 — blockForOwnerConfirm() (A-U4/D23 hard-hold)
// ============================================================================

test('[FIXTURE] blockForOwnerConfirm: task_events row now appears for in_progress→blocked (previously bypassed auditing)', () => {
  const wsId = seedWorkspace();
  const taskId = nextId('task-blockconfirm');
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'U99 blockForOwnerConfirm fixture', 'Original brief.', 'in_progress', 'high', ?, 'default', ?, ?)`,
    [taskId, wsId, now, now],
  );

  assert.equal(taskEventsFor(taskId).length, 0, 'no task_events rows should exist before the call');

  tasksLib.blockForOwnerConfirm(taskId, 'funnels', {
    hold: false,
    state: 'deadline_fallback',
    reason: 'confirm window expired',
    audienceLabel: null,
    candidates: [],
    prompt: 'Confirm the target audience before this funnel page is written.',
    firstHold: false,
  });

  const row = db.queryOne<{ status: string; block_audience: string | null }>(
    'SELECT status, block_audience FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(row?.status, 'blocked', 'task must be hard-held to blocked');
  assert.equal(row?.block_audience, 'OWNER', 'hard-hold must be OWNER audience, never house-voice');

  const events = taskEventsFor(taskId);
  assert.equal(events.length, 1, 'exactly one task_events row must now be written (the U99 gap this closes)');
  assert.equal(events[0].from_status, 'in_progress');
  assert.equal(events[0].to_status, 'blocked');

  // Idempotency: calling it again on an already-blocked task must NOT write a
  // second task_events row (the `changed !== 1` early-return this function
  // already had, now paired with the audit call placed AFTER that guard).
  tasksLib.blockForOwnerConfirm(taskId, 'funnels', {
    hold: false,
    state: 'deadline_fallback',
    reason: 'confirm window expired (second call)',
    audienceLabel: null,
    candidates: [],
    prompt: 'Confirm the target audience before this funnel page is written.',
    firstHold: false,
  });
  assert.equal(taskEventsFor(taskId).length, 1, 'a second call on an already-blocked task must not duplicate the audit row');
});
