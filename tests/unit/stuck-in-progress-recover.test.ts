/**
 * stuck-in-progress-recover.test.ts — SWEEP-RECOVER: the stuck-in-progress sweep
 * must NOT block FINISHED work. A task that completed but whose write-back 401'd
 * (the "carded-but-trapped" MC_API_TOKEN defect) leaves a registered deliverable
 * or on-disk output; the sweep recovers it to `review` (+ redelivers on-disk
 * output) instead of blocking it. A genuinely-empty stalled task still blocks.
 *
 *   node --import tsx --test tests/unit/stuck-in-progress-recover.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP;
process.env.STUCK_IN_PROGRESS_MINUTES = '45';

import './_isolated-db'; // MUST be first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { runStuckInProgressSweep } from '../../src/lib/jobs/stuck-in-progress-sweep';

getDb();

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
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
function seedStuckTask(title: string, workspaceId: string, agentId: string): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, assigned_agent_id, updated_at, last_progress_at)
     VALUES (?, ?, 'in_progress', ?, ?, ?, ?)`,
    [id, title, workspaceId, agentId, isoMinutesAgo(90), isoMinutesAgo(90)],
  );
  return id;
}

test('recovers a stalled in_progress task that HAS a registered deliverable → review, not blocked', async () => {
  const ws = seedWorkspace('presentations');
  const agentId = seedAgent(ws);
  const taskId = seedStuckTask(`Recover me ${uuidv4()}`, ws, agentId);

  // The agent finished: a deliverable is registered even though the status
  // write-back never advanced the card (the 401 trap).
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description)
     VALUES (?, ?, 'file', ?, ?, ?)`,
    [uuidv4(), taskId, 'Final deck', '/tmp/does-not-need-to-exist.html', 'delivered'],
  );

  const result = await runStuckInProgressSweep();
  assert.ok(result.recovered >= 1, 'at least one task recovered');
  assert.ok(result.recoveredIds.includes(taskId), 'the finished task was recovered');
  assert.ok(!result.blockedIds.includes(taskId), 'finished work is NOT blocked');

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.status, 'review', 'recovered forward to review for QC grading');

  const agent = queryOne<{ status: string }>('SELECT status FROM agents WHERE id = ?', [agentId]);
  assert.equal(agent?.status, 'standby', 'agent freed working → standby');

  const evt = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task_recovered'",
    [taskId],
  );
  assert.ok((evt?.n ?? 0) >= 1, 'a task_recovered event records the recovery');
});

test('still blocks a stalled in_progress task with NO deliverable and NO on-disk output', async () => {
  const ws = seedWorkspace('engineering');
  const agentId = seedAgent(ws);
  // A title unlikely to coincide with any real on-disk project dir.
  const taskId = seedStuckTask(`nonexistent-empty-${uuidv4()}`, ws, agentId);

  const result = await runStuckInProgressSweep();
  assert.ok(result.blockedIds.includes(taskId), 'genuinely-empty stalled task is blocked');
  assert.ok(!result.recoveredIds.includes(taskId), 'nothing to recover for an empty task');

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.status, 'blocked', 'empty stalled task transitions to blocked');
});
