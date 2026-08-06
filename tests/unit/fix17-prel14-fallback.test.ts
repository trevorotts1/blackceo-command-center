/**
 * FIX-17 pre-migration-114 fallback: the stale-return sweep must keep working
 * on a box where migration 114 (tasks.killed_at) has NOT yet run — the SELECT
 * must not reference a nonexistent column, and the text-marker kill path must
 * still fire from the description alone.
 *
 * Simulates the pre-114 shape by running the real migration chain (which adds
 * killed_at), then DROPPING the column to reproduce a mid-roll box. The sweep
 * must still (a) run without throwing "no such column", and (b) return a
 * NON-killed stale task to backlog (instrument works), and (c) hold a
 * text-marker OWNER KILLED task.
 */

import './_isolated-db'; // MUST be first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run, queryOne, queryAll, closeDb } from '../../src/lib/db';
import { runStaleTaskSweep } from '../../src/lib/jobs/stale-task-sweep';

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.DISABLE_STALE_TASK_SWEEP;

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

test('[FIX-17 pre-114] sweep runs without killed_at column; text-marker held; live task still returned', async () => {
  // Seed a workspace + agent (FK satisfiers) first (needs the schema BEFORE drop).
  const wsId = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [wsId, 'P', `p-${uuidv4().slice(0,8)}`]);
  const agentId = `a-${uuidv4()}`;
  run('INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, ?)', [
    agentId, 'Deck', 'Head', wsId, 'standby',
  ]);

  // Simulate a PRE-114 box: drop the killed_at column the migration chain added.
  const cols = queryAll<{ name: string }>('PRAGMA table_info(tasks)', []);
  assert.ok(cols.some((c) => c.name === 'killed_at'), 'fresh DB has killed_at (migration 114)');
  run('ALTER TABLE tasks DROP COLUMN killed_at');
  const afterDrop = queryAll<{ name: string }>('PRAGMA table_info(tasks)', []);
  assert.ok(!afterDrop.some((c) => c.name === 'killed_at'), 'killed_at dropped to simulate pre-114');

  // (a) live stale task → must still be returned (sweep instrument works pre-114).
  const liveId = `t-${uuidv4()}`;
  run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, assigned_agent_id, updated_at, last_progress_at)
     VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?)`,
    [liveId, 'Live stale', 'normal task', wsId, agentId, hoursAgo(30), hoursAgo(30)],
  );
  // (b) text-marker OWNER KILLED task → must be HELD (no killed_at column needed).
  const killedId = `t-${uuidv4()}`;
  run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, assigned_agent_id, updated_at, last_progress_at)
     VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?)`,
    [killedId, 'Marker killed', 'OWNER KILLED — do not start any new presentation work.', wsId, agentId, hoursAgo(30), hoursAgo(30)],
  );

  const result = await runStaleTaskSweep(); // MUST NOT throw on the missing column

  const live = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [liveId]);
  assert.equal(live?.status, 'backlog', 'pre-114: live stale task IS returned to backlog (no column regression)');

  const killed = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [killedId]);
  assert.equal(killed?.status, 'in_progress', 'pre-114: text-marker killed task is HELD (not returned)');

  const ev = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'dispatch_blocked_owner_killed'`,
    [killedId],
  );
  assert.ok((ev?.n ?? 0) >= 1, 'pre-114: dispatch_blocked_owner_killed event written for text-marker task');
  assert.ok(result.scanned >= 1, 'sweep scanned candidates pre-114');
});

test('[FIX-17 pre-114] cleanup', () => {
  closeDb();
});
