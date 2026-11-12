/**
 * jobs-fourth-pass-safety.test.ts — U-16, the fourth-pass job safety net.
 *
 * Five groups, one claim each:
 *   1. A job an operator switched off SAYS SO: the sweep resolves a non-empty
 *      `skippedReason` instead of a bare `undefined`, so the liveness watchdog
 *      records 'disabled' rather than a false green.
 *   2. A dead card is not kept alive by another job's bookkeeping. Background
 *      writes (trust-*, backfill, note clean-up) are NOT agent progress, so a
 *      card whose only recent event is one of those is blocked — while a real
 *      status change still holds it, and the 12h hard ceiling overrides both.
 *   3. A card that left In Progress while the sweep was checking it is left
 *      where the other writer put it: no block metadata, no alert, no count.
 *   4. Gateway history older than the stall cut-off is not "alive": a row the
 *      gateway has lost is failed, while a fresh message (or a gateway that
 *      omits timestamps entirely) still counts as alive.
 *   5. Every job function hands its own result back to `wrap()` (tested by
 *      calling the fn directly — no timer is ever registered).
 *
 *   node --import tsx --test tests/unit/jobs-fourth-pass-safety.test.ts
 */

// Keep every notify path silent + local (no Telegram / webhook shell-out).
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_NOTIFY_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP;
delete process.env.STUCK_IN_PROGRESS_HARD_CEILING_MINUTES; // default 720
process.env.STUCK_IN_PROGRESS_MINUTES = '180'; // the shipped default, pinned here

import './_isolated-db'; // MUST be first DB-reaching import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { runStuckInProgressSweep } from '../../src/lib/jobs/stuck-in-progress-sweep';
import {
  reconcileStalledExecutions,
  runExecutionCompletionReconcile,
  type RawSessionEntry,
} from '../../src/lib/jobs/execution-watcher';
import { __jobFnForTests } from '../../src/lib/jobs/scheduler';
import { executionSessionId } from '../../src/lib/execution-attempts';

getDb();

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

function seedWorkspace(label: string): string {
  const id = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [
    id, label, `${label}-${uuidv4().slice(0, 8)}`,
  ]);
  return id;
}

function seedAgent(workspaceId: string, status = 'working'): string {
  const id = uuidv4();
  run('INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, ?)', [
    id, 'Fourth Pass Worker', 'Department Head', workspaceId, status,
  ]);
  return id;
}

function seedInProgressTask(workspaceId: string, agentId: string | null, progressMinutesAgo: number): string {
  const id = uuidv4();
  const stamp = minutesAgo(progressMinutesAgo);
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, assigned_agent_id, updated_at, last_progress_at)
     VALUES (?, ?, 'in_progress', ?, ?, ?, ?)`,
    [id, 'Fourth pass card', workspaceId, agentId, stamp, stamp],
  );
  return id;
}

function seedEvent(taskId: string, type: string, agentId: string | null, ageMinutes: number): void {
  run(
    `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), type, agentId, taskId, 'background bookkeeping', minutesAgo(ageMinutes)],
  );
}

const statusOf = (taskId: string): string | undefined =>
  queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])?.status;

// ── Group 1: a switched-off job reports why it did nothing ──────────────────

test('1. a switched-off sweep resolves a non-empty skippedReason', async () => {
  process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP = '1';
  try {
    const swept = await runStuckInProgressSweep();
    assert.ok(
      typeof swept.skippedReason === 'string' && swept.skippedReason.length > 0,
      'the stuck sweep names the kill flag instead of reporting a silent nothing',
    );
  } finally {
    delete process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP;
  }

  process.env.EXECUTION_WATCHER_ENABLED = '0';
  try {
    const reconciled = await runExecutionCompletionReconcile();
    assert.ok(
      typeof reconciled.skippedReason === 'string' && reconciled.skippedReason.length > 0,
      'the execution reconcile names the switch instead of resolving undefined',
    );
  } finally {
    delete process.env.EXECUTION_WATCHER_ENABLED;
  }
});

// ── Group 2: background bookkeeping is not liveness ─────────────────────────

test('2a. a dead card is blocked even though a background job wrote trust_progress 5 min ago', async () => {
  const ws = seedWorkspace('fourth-trust');
  const agentId = seedAgent(ws);
  const taskId = seedInProgressTask(ws, agentId, 240); // 4h — past the 180-min threshold
  seedEvent(taskId, 'trust_progress', null, 5);

  const result = await runStuckInProgressSweep();

  assert.ok(result.blockedIds.includes(taskId), 'trust_progress is bookkeeping, not agent progress');
  assert.equal(statusOf(taskId), 'blocked', 'the silently-dead card is blocked');
});

test('2b. a real status change 5 min ago still holds the card', async () => {
  const ws = seedWorkspace('fourth-status');
  const agentId = seedAgent(ws);
  const taskId = seedInProgressTask(ws, agentId, 240);
  seedEvent(taskId, 'task_status_changed', agentId, 5);

  const result = await runStuckInProgressSweep();

  assert.ok(!result.blockedIds.includes(taskId), 'genuine recent activity is still liveness');
  assert.equal(statusOf(taskId), 'in_progress', 'the card keeps running');
});

test('2c. the 12-hour hard ceiling overrides even a recent status change', async () => {
  const ws = seedWorkspace('fourth-ceiling');
  const agentId = seedAgent(ws);
  const taskId = seedInProgressTask(ws, agentId, 13 * 60); // 13h — past the 720-min ceiling
  seedEvent(taskId, 'task_status_changed', agentId, 5);

  const result = await runStuckInProgressSweep();

  assert.ok(result.blockedIds.includes(taskId), 'no in_progress card outlives the hard ceiling');
  assert.equal(statusOf(taskId), 'blocked', 'the ceiling force-blocks it');
});

// ── Group 3: the card leaves In Progress mid-sweep ──────────────────────────

test('3. a card that moved to review during the sweep is not blocked', async () => {
  const ws = seedWorkspace('fourth-race');
  const agentId = seedAgent(ws);
  // The sweep selects every in_progress row FIRST, then blocks them one at a
  // time. The decoy's block is the write we hook: it flips the target to
  // `review` from inside the sweep's loop, i.e. exactly the read→write window a
  // concurrent writer opens. No module mock is needed and nothing is timed.
  const decoy = seedInProgressTask(ws, agentId, 240);
  const target = seedInProgressTask(ws, agentId, 240);
  run(
    `CREATE TRIGGER u16_race_after_block AFTER INSERT ON task_events
       WHEN NEW.to_status = 'blocked' AND NEW.task_id = '${decoy}'
     BEGIN
       UPDATE tasks SET status = 'review', updated_at = datetime('now') WHERE id = '${target}';
     END`,
  );

  try {
    const result = await runStuckInProgressSweep();

    assert.ok(result.blockedIds.includes(decoy), 'the decoy card is blocked (this is the hook firing)');
    assert.ok(!result.blockedIds.includes(target), 'the card another writer moved is NOT counted as blocked');
    assert.equal(result.blocked, 1, 'only the decoy is counted');

    const row = queryOne<{ status: string; block_reason: string | null }>(
      'SELECT status, block_reason FROM tasks WHERE id = ?',
      [target],
    );
    assert.equal(row?.status, 'review', 'the card stays where the other writer put it');
    assert.equal(row?.block_reason, null, 'no block metadata is written for a card the sweep did not block');
  } finally {
    run('DROP TRIGGER IF EXISTS u16_race_after_block');
  }
});

// ── Group 4: gateway history older than the stall cut-off is not alive ──────

const RACE_AGENT_ID = `agent-${uuidv4()}`;
run(`INSERT INTO agents (id, name, role, workspace_id) VALUES (?, 'Fourth Pass Reconcile Worker', 'Department Head', NULL)`, [
  RACE_AGENT_ID,
]);
const WORKER_CONTEXT = JSON.stringify([null, null, null, null]);

function seedStalledExecution(
  state: 'accepted' | 'running' = 'accepted',
  ageMinutes = 30,
): { taskId: string; executionId: string; sessionKey: string; sessionId: string } {
  const taskId = uuidv4();
  const executionId = uuidv4();
  const sessionId = executionSessionId(RACE_AGENT_ID, executionId);
  const sessionKey = `agent:dept-marketing:${sessionId}`;
  const stamp = minutesAgo(ageMinutes);
  run(
    `INSERT INTO tasks (id, title, status, assigned_agent_id, assignment_version, workspace_id, created_at, updated_at)
     VALUES (?, 'Stalled fourth-pass dispatch', 'in_progress', ?, 0, NULL, ?, ?)`,
    [taskId, RACE_AGENT_ID, stamp, stamp],
  );
  run(
    `INSERT INTO task_executions
      (id, task_id, assignment_version, agent_id, generation, worker_context, session_key, session_id,
       state, lease_owner, lease_expires_at, idempotency_key, provider, created_at, updated_at)
     VALUES (?, ?, 0, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'ollama', ?, ?)`,
    [executionId, taskId, RACE_AGENT_ID, WORKER_CONTEXT, sessionKey, sessionId, state, uuidv4(), stamp,
      `execution-${executionId}`, stamp, stamp],
  );
  return { taskId, executionId, sessionKey, sessionId };
}

/** Leave exactly this row active so the reconcile only judges one execution. */
function onlyRow(executionId: string): void {
  run(`UPDATE task_executions SET state = 'succeeded' WHERE state IN ('accepted','running') AND id <> ?`, [executionId]);
}

const noSessions = async (): Promise<RawSessionEntry[]> => [];

test('4a. a message two hours old does not keep a lost run alive → failed', async () => {
  const { executionId } = seedStalledExecution('running', 90);
  onlyRow(executionId);

  const result = await reconcileStalledExecutions({
    reader: async () => [{ role: 'assistant', content: 'Working on it.', ts: Date.now() - 2 * 60 * 60_000 }],
    sessions: noSessions,
    gatewayConnected: true,
  });

  assert.equal(result.failed, 1, 'stale history is not activity; the run the gateway lost is failed');
  assert.equal(result.alive, 0, 'nothing is counted alive on a two-hour-old message');
});

test('4b. a message one minute old is alive', async () => {
  const { executionId } = seedStalledExecution('accepted', 30);
  onlyRow(executionId);

  const result = await reconcileStalledExecutions({
    reader: async () => [{ role: 'assistant', content: 'Working on it.', ts: Date.now() - 60_000 }],
    sessions: noSessions,
    gatewayConnected: true,
  });

  assert.equal(result.alive, 1, 'a message newer than the cutoff is genuine activity');
  assert.equal(result.failed, 0, 'a live run is never failed');
});

test('4c. a message with no timestamp keeps the benefit of the doubt → alive', async () => {
  const { executionId } = seedStalledExecution('accepted', 30);
  onlyRow(executionId);

  const result = await reconcileStalledExecutions({
    reader: async () => [{ role: 'assistant', content: 'Working on it.' }],
    sessions: noSessions,
    gatewayConnected: true,
  });

  assert.equal(result.alive, 1, 'a gateway that omits timestamps cannot be called dead');
  assert.equal(result.failed, 0, 'never failed on an unreadable clock');
});

// ── Group 5: each job function hands its result back to wrap() ──────────────

test('5. each job fn returns its own result (and never registers a timer)', async () => {
  const disabled: Array<[string, string]> = [
    ['stuck-in-progress-sweep', 'DISABLE_STUCK_IN_PROGRESS_SWEEP'],
    ['trust-engine', 'DISABLE_TRUST_ENGINE'],
    ['board-hygiene', 'DISABLE_BOARD_HYGIENE'],
    ['stale-task-sweep', 'DISABLE_STALE_TASK_SWEEP'],
  ];

  for (const [job, flag] of disabled) {
    const fn = __jobFnForTests(job);
    assert.ok(fn, `${job} is declared in the JOBS array`);

    process.env[flag] = '1';
    try {
      const result = (await fn!()) as { skippedReason?: string } | undefined;
      assert.ok(result, `${job} returns its result instead of undefined`);
      assert.ok(
        typeof result!.skippedReason === 'string' && result!.skippedReason.length > 0,
        `${job} hands wrap() the reason it did nothing`,
      );
    } finally {
      delete process.env[flag];
    }
  }

  assert.ok(__jobFnForTests('execution-reconcile'), 'execution-reconcile is registered with its own lease');
});
