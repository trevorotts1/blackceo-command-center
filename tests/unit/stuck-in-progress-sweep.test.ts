/**
 * stuck-in-progress-sweep.test.ts — silent-failure safety-net guard (DB-backed).
 *
 * Reproduces the incident class: a task successfully dispatched to `in_progress`
 * whose agent turn then died silently (no TASK_COMPLETE, no terminal status).
 * Asserts the sweep blocks it, frees the agent, writes the audit event the raw
 * paths skip, and leaves genuinely-fresh / genuinely-active tasks untouched.
 *
 *   DATABASE_PATH=/tmp/scratch-stuck.db \
 *     node --import tsx --test tests/unit/stuck-in-progress-sweep.test.ts
 */

// Suppress the owner-notify shell-out in the alert path during tests.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP;
process.env.STUCK_IN_PROGRESS_MINUTES = '45';

import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { runStuckInProgressSweep } from '../../src/lib/jobs/stuck-in-progress-sweep';

const db = getDb();

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

function seedWorkspace(label: string): string {
  // Random unique slug so we never collide with the first-boot auto-seeded
  // department workspaces (the slug is irrelevant to the sweep).
  const slug = `${label}-${uuidv4().slice(0, 8)}`;
  const id = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [id, label, slug]);
  return id;
}

function seedAgent(workspaceId: string, status = 'working'): string {
  const id = uuidv4();
  run('INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, ?)', [
    id, 'Director of Communications', 'Department Head', workspaceId, status,
  ]);
  return id;
}

function seedTask(opts: {
  status: string;
  workspaceId: string;
  agentId: string | null;
  updatedAt: string;
  lastProgressAt?: string | null;
}): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, assigned_agent_id, updated_at, last_progress_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, 'Send the client the summary', opts.status, opts.workspaceId, opts.agentId, opts.updatedAt, opts.lastProgressAt ?? null],
  );
  return id;
}

test('blocks a silently-stuck in_progress task, frees the agent, and writes the audit event', async () => {
  const ws = seedWorkspace('communications');
  const agentId = seedAgent(ws, 'working');
  // in_progress for 90 min with no progress and no activity events → silent death.
  const taskId = seedTask({
    status: 'in_progress',
    workspaceId: ws,
    agentId,
    updatedAt: isoMinutesAgo(90),
    lastProgressAt: isoMinutesAgo(90),
  });

  const result = await runStuckInProgressSweep();
  assert.equal(result.blocked, 1, 'exactly one task blocked');
  assert.ok(result.blockedIds.includes(taskId), 'the stuck task is in the blocked set');

  const task = queryOne<{ status: string; block_reason: string | null; block_audience: string | null; blocked_on_human: string | null }>(
    'SELECT status, block_reason, block_audience, blocked_on_human FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.status, 'blocked', 'task transitioned to blocked');
  assert.ok(task?.block_reason && /no progress/i.test(task.block_reason), 'block_reason captures the failure');
  assert.equal(task?.block_audience, 'SYSTEM', 'audience is SYSTEM (operator feed, not client)');
  assert.equal(task?.blocked_on_human, 'operator', 'escalated to operator');

  const agent = queryOne<{ status: string }>('SELECT status FROM agents WHERE id = ?', [agentId]);
  assert.equal(agent?.status, 'standby', 'wedged agent freed from working → standby');

  // The structured audit row that a raw UPDATE would have skipped.
  const evt = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND to_status = 'blocked'",
    [taskId],
  );
  assert.ok((evt?.n ?? 0) >= 1, 'a task_events row records the in_progress → blocked transition');
});

test('leaves a fresh in_progress task alone', async () => {
  const ws = seedWorkspace('marketing');
  const agentId = seedAgent(ws, 'working');
  const taskId = seedTask({
    status: 'in_progress',
    workspaceId: ws,
    agentId,
    updatedAt: isoMinutesAgo(5), // well under the 45-min threshold
    lastProgressAt: isoMinutesAgo(5),
  });

  const result = await runStuckInProgressSweep();
  assert.ok(!result.blockedIds.includes(taskId), 'fresh task not blocked');
  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.status, 'in_progress', 'fresh task stays in_progress');
});

test('liveness guard: skips an old task that still has recent activity events', async () => {
  const ws = seedWorkspace('engineering');
  const agentId = seedAgent(ws, 'working');
  const taskId = seedTask({
    status: 'in_progress',
    workspaceId: ws,
    agentId,
    updatedAt: isoMinutesAgo(120),
    lastProgressAt: isoMinutesAgo(120),
  });
  // A recent activity event → the agent is alive, just long-running.
  run(
    `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), 'task_progress', agentId, taskId, 'still working', isoMinutesAgo(2)],
  );

  const result = await runStuckInProgressSweep();
  assert.ok(!result.blockedIds.includes(taskId), 'active-but-long task not blocked (liveness guard)');
  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.status, 'in_progress', 'long-running-but-alive task stays in_progress');
});

test('respects the DISABLE_STUCK_IN_PROGRESS_SWEEP opt-out', async () => {
  const ws = seedWorkspace('sales');
  const agentId = seedAgent(ws, 'working');
  const taskId = seedTask({
    status: 'in_progress',
    workspaceId: ws,
    agentId,
    updatedAt: isoMinutesAgo(300),
    lastProgressAt: isoMinutesAgo(300),
  });

  process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP = '1';
  try {
    const result = await runStuckInProgressSweep();
    assert.equal(result.scanned, 0, 'sweep is a no-op when disabled');
    assert.ok(!result.blockedIds.includes(taskId), 'disabled sweep blocks nothing');
  } finally {
    delete process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP;
  }
  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.status, 'in_progress', 'task untouched while disabled');
});
