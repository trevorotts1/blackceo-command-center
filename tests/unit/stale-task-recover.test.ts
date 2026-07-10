/**
 * stale-task-recover.test.ts — the STALE sweep (every 10 min, in_progress
 * threshold 24h) must ALSO not discard finished work. Previously it bounced a stalled
 * in_progress task straight to `backlog` via returnToOrchestrator() with no disk
 * check, so a task that FINISHED but whose write-back 401'd (carded-but-trapped)
 * was thrown back to backlog. It now shares the finished-work-recovery gate with
 * the stuck sweep: finished in_progress work is recovered to `review`; a
 * genuinely-empty stale task still returns to backlog.
 *
 *   node --import tsx --test tests/unit/stale-task-recover.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.DISABLE_STALE_TASK_SWEEP;

import './_isolated-db'; // MUST be first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run, queryOne } from '../../src/lib/db';
import { runStaleTaskSweep } from '../../src/lib/jobs/stale-task-sweep';

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}
function seedWorkspace(label: string): string {
  const id = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [id, label, `${label}-${uuidv4().slice(0, 8)}`]);
  return id;
}
function seedAgent(workspaceId: string): string {
  const id = uuidv4();
  run('INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, ?)', [
    id, 'Deck Designer', 'Department Head', workspaceId, 'working',
  ]);
  return id;
}
/** in_progress, no progress for 30h (> 24h stale threshold). */
function seedStaleInProgress(title: string, ws: string, agentId: string): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, assigned_agent_id, updated_at, last_progress_at)
     VALUES (?, ?, 'in_progress', ?, ?, ?, ?)`,
    [id, title, ws, agentId, hoursAgo(30), hoursAgo(30)],
  );
  return id;
}

test('recovers a stale in_progress task WITH a registered deliverable → review, NOT backlog', async () => {
  const ws = seedWorkspace('presentations');
  const agentId = seedAgent(ws);
  const taskId = seedStaleInProgress(`Stale finished ${uuidv4()}`, ws, agentId);
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description)
     VALUES (?, ?, 'file', ?, ?, ?)`,
    [uuidv4(), taskId, 'Final deck', '/tmp/not-needed.html', 'delivered'],
  );

  const result = await runStaleTaskSweep();
  assert.ok((result.recovered ?? 0) >= 1, 'at least one task recovered');
  assert.ok((result.recoveredIds ?? []).includes(taskId), 'the finished task was recovered');

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.status, 'review', 'recovered forward to review, not bounced to backlog');

  const evt = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task_recovered'",
    [taskId],
  );
  assert.ok((evt?.n ?? 0) >= 1, 'a task_recovered event records the recovery');
});

test('still returns a genuinely-empty stale in_progress task to backlog', async () => {
  const ws = seedWorkspace('engineering');
  const agentId = seedAgent(ws);
  const taskId = seedStaleInProgress(`nonexistent-empty-${uuidv4()}`, ws, agentId);

  const result = await runStaleTaskSweep();
  assert.ok(!(result.recoveredIds ?? []).includes(taskId), 'nothing to recover for an empty task');

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.status, 'backlog', 'empty stale in_progress task returns to backlog');
});
