/**
 * FIX-17 (Error 12 / Rule R12) — OWNER-KILLED tasks must never be re-dispatched.
 *
 * BUG: On Aug 5 the orchestrator re-dispatched `fb2a8e72` — a task the owner
 * killed Jul 21 05:21 EDT (deliverable already sent). The dispatch said "LIVE:
 * This is the live request the owner is waiting on" while its own body quoted
 * the kill notice "do NOT start any new presentation work until the owner sends
 * the new request." The stale-return sweeper ignored the kill note → 4 identical
 * handback stalls (not 4 different problems).
 *
 * FIX (FIX-RECOMMENDATIONS FIX-17 / ERRORS-DETECTED Fix 12): exclude tasks whose
 * notes contain an `OWNER KILLED` marker (or whose `killed_at` column is set)
 * from re-dispatch. A killed task is TERMINAL-for-dispatch: the stale-return
 * sweeper must not return it to the orchestrator, autoDispatchTask must refuse
 * it, and any blocked attempt writes a `dispatch_blocked_owner_killed` event.
 *
 * QC GATE (from the Gauntlet doc FIX-17 row):
 *   Set `killed_at` on a task; run the stale-return sweep; also test the
 *   text-marker "OWNER KILLED" path.
 *   → Task NOT dispatched; `dispatch_blocked_owner_killed` event written;
 *     text-marker task held.
 *   Evidence: Sweep output (task absent from returned/re-pinged) + event row.
 *
 * This suite proves the gate at three layers, isolated DB, no network:
 *   1. The guard primitives (isOwnerKilled / blockDispatchIfOwnerKilled) — both
 *      the killed_at column and the text-marker paths.
 *   2. The stale-return sweep (runStaleTaskSweep) — a killed task is NOT
 *      returned to the orchestrator (the exact incident), and the event row is
 *      written.
 *   3. autoDispatchTask's GUARD 4b — a killed task is refused at the central
 *      dispatch chokepoint (covers intake-advance, backlog-redispatch,
 *      ceo-delegation, auto-route, createTaskCore).
 *
 * Known-good controls are built in: a NON-killed stale task IS returned by the
 * sweep (instrument works), and a non-killed task is NOT blocked by the guard.
 */

import './_isolated-db'; // MUST be first — isolated temp DB, never the live board.

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run, queryOne, queryAll, closeDb } from '../../src/lib/db';
import { runStaleTaskSweep } from '../../src/lib/jobs/stale-task-sweep';
import { autoDispatchTask } from '../../src/lib/task-dispatcher';
import {
  isOwnerKilled,
  blockDispatchIfOwnerKilled,
  OWNER_KILLED_BLOCK_EVENT,
  OWNER_KILLED_MARKER,
} from '../../src/lib/owner-killed';

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.DISABLE_STALE_TASK_SWEEP;
process.env.INTAKE_ADVANCE_SWEEP_ENABLED = '0';

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

/** Seed a workspace + agent (FK satisfiers) and return the ids. */
function seedWorkspaceAndAgent(): { wsId: string; agentId: string } {
  const wsId = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [wsId, 'Test WS', `ws-${uuidv4().slice(0, 8)}`]);
  const agentId = `agent-${uuidv4()}`;
  run('INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, ?)', [
    agentId, 'Deck Designer', 'Department Head', wsId, 'standby',
  ]);
  return { wsId, agentId };
}

/**
 * Seed a stale `in_progress` task (30h no progress > 24h threshold) with the
 * given description + killed_at. Returns the task id.
 */
function seedStaleInProgress(
  title: string,
  wsId: string,
  agentId: string,
  opts: { description?: string | null; killed_at?: string | null } = {},
): string {
  const id = `task-${uuidv4()}`;
  run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, assigned_agent_id, updated_at, last_progress_at, killed_at)
     VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?, ?)`,
    [id, title, opts.description ?? null, wsId, agentId, hoursAgo(30), hoursAgo(30), opts.killed_at ?? null],
  );
  return id;
}

function eventCount(taskId: string, type: string): number {
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = ?`,
    [taskId, type],
  );
  return row?.n ?? 0;
}

// ── 1. Guard primitives ──────────────────────────────────────────────────────

test('[FIX-17] isOwnerKilled: killed_at column path → killed', () => {
  const res = isOwnerKilled({ killed_at: '2026-07-21T05:21:00Z', description: 'sermon' });
  assert.equal(res.killed, true);
  assert.equal(res.source, 'killed_at');
  assert.equal(res.killedAt, '2026-07-21T05:21:00Z');
});

test('[FIX-17] isOwnerKilled: text-marker path → killed', () => {
  const res = isOwnerKilled({
    killed_at: null,
    description: `[OWNER KILLED] do NOT start any new presentation work until the owner sends the new request.`,
  });
  assert.equal(res.killed, true);
  assert.equal(res.source, 'note_marker');
});

test('[FIX-17] isOwnerKilled: marker is case-insensitive', () => {
  const res = isOwnerKilled({ description: 'Please note: owner killed this request 2026-07-21.' });
  assert.equal(res.killed, true);
  assert.equal(res.source, 'note_marker');
});

test('[FIX-17] isOwnerKilled: a normal task is NOT killed (known-good control)', () => {
  const res = isOwnerKilled({ killed_at: null, description: 'Build a 20-slide deck about Q3 results.' });
  assert.equal(res.killed, false);
  assert.equal(res.source, null);
});

test('[FIX-17] isOwnerKilled: notes alias is consulted', () => {
  const res = isOwnerKilled({ notes: `OWNER KILLED — do not revive.` });
  assert.equal(res.killed, true);
});

// ── 2. blockDispatchIfOwnerKilled writes the event (deduped) ────────────────
test('[FIX-17] blockDispatchIfOwnerKilled blocks + writes dispatch_blocked_owner_killed once', () => {
  const { wsId, agentId } = seedWorkspaceAndAgent();
  const taskId = seedStaleInProgress('Killed deck', wsId, agentId, {
    killed_at: '2026-07-21T05:21:00Z',
  });

  const first = blockDispatchIfOwnerKilled(
    { id: taskId, title: 'Killed deck', killed_at: '2026-07-21T05:21:00Z' },
    'test',
  );
  assert.equal(first, true, 'a killed task must be blocked');
  assert.equal(eventCount(taskId, OWNER_KILLED_BLOCK_EVENT), 1, 'event written on first block');

  const second = blockDispatchIfOwnerKilled(
    { id: taskId, title: 'Killed deck', killed_at: '2026-07-21T05:21:00Z' },
    'test-again',
  );
  assert.equal(second, true, 'still blocked');
  assert.equal(eventCount(taskId, OWNER_KILLED_BLOCK_EVENT), 1, 'event is DEDUPED — one row total');
});

test('[FIX-17] blockDispatchIfOwnerKilled does NOT block a live task (known-good control)', () => {
  const blocked = blockDispatchIfOwnerKilled(
    { id: 'no-such-task', title: 'Live deck', killed_at: null, description: 'Normal task.' },
    'test',
  );
  assert.equal(blocked, false, 'a live task is not blocked');
});

// ── 3. Stale-return sweep: killed task NOT returned (the exact incident) ────
test('[FIX-17] stale-return sweep: killed_at task is NOT returned to the orchestrator + event written', async () => {
  const { wsId, agentId } = seedWorkspaceAndAgent();
  const killedId = seedStaleInProgress(`Killed sermon ${uuidv4()}`, wsId, agentId, {
    killed_at: '2026-07-21T05:21:00Z',
  });

  const result = await runStaleTaskSweep();

  // Killed task: NOT returned (the incident would have returned it to backlog).
  assert.ok(
    !result.returned || result.scanned >= 0,
    'sweep ran',
  );
  const killed = queryOne<{ status: string; killed_at: string | null }>(
    'SELECT status, killed_at FROM tasks WHERE id = ?',
    [killedId],
  );
  assert.equal(killed?.status, 'in_progress', 'killed task was NOT flipped to backlog (not returned to orchestrator)');
  assert.equal(eventCount(killedId, OWNER_KILLED_BLOCK_EVENT), 1, 'dispatch_blocked_owner_killed event written for killed task');
});

test('[FIX-17] stale-return sweep: text-marker "OWNER KILLED" task is HELD (not returned)', async () => {
  const { wsId, agentId } = seedWorkspaceAndAgent();
  const markerId = seedStaleInProgress(`Marker killed ${uuidv4()}`, wsId, agentId, {
    description: `[${OWNER_KILLED_MARKER}] do NOT start any new presentation work until the owner sends the new request.`,
  });

  await runStaleTaskSweep();

  const marker = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [markerId]);
  assert.equal(marker?.status, 'in_progress', 'text-marker killed task is HELD (not returned to backlog)');
  assert.equal(eventCount(markerId, OWNER_KILLED_BLOCK_EVENT), 1, 'dispatch_blocked_owner_killed event written for text-marker task');
});

test('[FIX-17] stale-return sweep: a NON-killed stale task IS still returned (known-good control)', async () => {
  const { wsId, agentId } = seedWorkspaceAndAgent();
  const liveId = seedStaleInProgress(`Live stale ${uuidv4()}`, wsId, agentId, {
    description: 'A normal stale task with no kill marker.',
  });

  const result = await runStaleTaskSweep();
  // The sweep must still do its job for live tasks (instrument works).
  const live = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [liveId]);
  assert.equal(live?.status, 'backlog', 'a live stale task IS returned to backlog (sweep instrument works)');
  assert.equal(eventCount(liveId, OWNER_KILLED_BLOCK_EVENT), 0, 'no owner-killed event for a live task');
  assert.ok(result.scanned >= 1, 'sweep scanned at least one task');
});

// ── 4. autoDispatchTask GUARD 4b: killed task refused at the chokepoint ─────
test('[FIX-17] autoDispatchTask refuses a killed_at task (no task_dispatched / no in_progress flip)', async () => {
  const { wsId, agentId } = seedWorkspaceAndAgent();
  const taskId = seedStaleInProgress(`Auto-dispatch killed ${uuidv4()}`, wsId, agentId, {
    killed_at: '2026-07-21T05:21:00Z',
  });
  // Give it an assigned agent + backlog status (a normal dispatchable state).
  run(`UPDATE tasks SET status = 'backlog', assigned_agent_id = ?, updated_at = ? WHERE id = ?`, [
    agentId, hoursAgo(1), taskId,
  ]);

  await autoDispatchTask(taskId, 'test');

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.status, 'backlog', 'killed task was NOT dispatched (no in_progress flip)');
  assert.equal(eventCount(taskId, 'task_dispatched'), 0, 'no task_dispatched event');
  assert.equal(eventCount(taskId, OWNER_KILLED_BLOCK_EVENT), 1, 'dispatch_blocked_owner_killed event written');
});

test('[FIX-17] autoDispatchTask refuses a text-marker killed task', async () => {
  const { wsId, agentId } = seedWorkspaceAndAgent();
  const taskId = seedStaleInProgress(`Auto marker ${uuidv4()}`, wsId, agentId, {
    description: `OWNER KILLED — sermon already delivered.`,
  });
  run(`UPDATE tasks SET status = 'backlog', assigned_agent_id = ?, updated_at = ? WHERE id = ?`, [
    agentId, hoursAgo(1), taskId,
  ]);

  await autoDispatchTask(taskId, 'test');

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.status, 'backlog', 'text-marker killed task was NOT dispatched');
  assert.equal(eventCount(taskId, OWNER_KILLED_BLOCK_EVENT), 1, 'dispatch_blocked_owner_killed event written');
});

// ── 5. Migration 114: killed_at column exists on a fresh DB ─────────────────
test('[FIX-17] migration 114 adds tasks.killed_at (column present on fresh DB)', () => {
  const cols = queryAll<{ name: string }>('PRAGMA table_info(tasks)', []);
  assert.ok(cols.some((c) => c.name === 'killed_at'), 'tasks.killed_at column must exist after migrations');
});

test('[FIX-17] cleanup: close the isolated DB', () => {
  closeDb();
});
