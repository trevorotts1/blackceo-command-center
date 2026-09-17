/**
 * SWEEP-LOOP regression: a task already in `backlog` past the stale threshold
 * must NOT be "returned" to backlog. transition('backlog'→'backlog') is an
 * idempotent no-op that writes no extraColumns, so pre-fix the sweep wrote a
 * task_returned event for the same card on every tick, forever.
 *
 * Run: node --import tsx --test tests/unit/stale-task-sweep-backlog-loop.test.ts
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
function seedWorkspace(): string {
  const id = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [id, 'marketing', `marketing-${uuidv4().slice(0, 8)}`]);
  return id;
}
function seedTask(status: string, ws: string, ageHours: number): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, updated_at, last_progress_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `Stale ${status} ${uuidv4()}`, status, ws, hoursAgo(ageHours), hoursAgo(ageHours)],
  );
  return id;
}
function returnedEvents(taskId: string): number {
  return queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE type='task_returned' AND task_id=?`, [taskId])?.n ?? 0;
}

test('a backlog card past the 48h threshold is counted, not returned: no task_returned event on two consecutive ticks', async () => {
  const ws = seedWorkspace();
  const taskId = seedTask('backlog', ws, 50);

  const first = await runStaleTaskSweep();
  assert.ok((first.alreadyInBacklog ?? 0) >= 1, 'the stale backlog card is counted as already-with-orchestrator');
  assert.equal(returnedEvents(taskId), 0, 'no task_returned event on tick 1');

  const second = await runStaleTaskSweep();
  assert.ok((second.alreadyInBacklog ?? 0) >= 1);
  assert.equal(returnedEvents(taskId), 0, 'still no task_returned event on tick 2 (the loop is closed)');

  const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id=?', [taskId]);
  assert.equal(row?.status, 'backlog', 'the card stays where it was');
});

test('a review card past its threshold is still returned to backlog exactly once (real moves are unaffected)', async () => {
  const ws = seedWorkspace();
  const taskId = seedTask('review', ws, 200);

  const first = await runStaleTaskSweep();
  assert.ok(first.returned >= 1, 'a genuinely stale review card is returned');
  // returnToOrchestrator is fire-and-forget inside the loop; let it settle.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(returnedEvents(taskId), 1, 'exactly one task_returned event');
  const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id=?', [taskId]);
  assert.equal(row?.status, 'backlog');

  await runStaleTaskSweep();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(returnedEvents(taskId), 1, 'the second tick does not return it again — it is now a backlog card');
});
