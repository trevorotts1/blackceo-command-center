/**
 * execution-accepted-orphan-2026-09.test.ts — A RUN THE GATEWAY TOOK AND LOST.
 *
 * `chat.send` is acknowledged, the execution row goes `accepted`, and then the
 * gateway process dies before the run produces anything. Measured on a client
 * box: two executions accepted at 23:42 UTC, the gateway killed by an unhandled
 * rejection at 23:43:59 after a 77-second event-loop freeze, back at 00:03:50 —
 * and both rows still `accepted` thirty minutes later, `updated_at` frozen at
 * the acknowledgement, `error_code` NULL, each still holding its task slot, its
 * worker slot and its provider pool slot.
 *
 * Nothing reconciled that shape: reconcileUnknownExecutions() only looks at
 * `unknown`, and recoverExpiredExecutions() only flips `sending` rows past their
 * lease, which an `accepted` row no longer has.
 *
 *   node --import tsx --test tests/unit/execution-accepted-orphan-2026-09.test.ts
 */

import './_isolated-db'; // MUST be the first DB-reaching import (C8 guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { executionSessionId } from '../../src/lib/execution-attempts';
import { ACTIVE_EXECUTION_STATES_SQL } from '../../src/lib/execution-schema';
import {
  reconcileStalledExecutions,
  acceptedStallAfterMs,
  type RawHistoryMessage,
  type RawSessionEntry,
} from '../../src/lib/jobs/execution-watcher';

getDb(); // apply the migration chain (agents, tasks, task_executions, task_activities).

const AGENT_ID = `agent-${uuidv4()}`;
run(`INSERT INTO agents (id, name, role, workspace_id) VALUES (?, 'Orphan Worker', 'Department Head', NULL)`, [AGENT_ID]);

/** What workerContext() computes for the agent above — validateExecutionCompletion
 *  compares the execution's stored copy against it before any completion lands. */
const WORKER_CONTEXT = JSON.stringify([null, null, null, null]);
const PROVIDER = 'ollama';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** One accepted-but-orphaned dispatch, as the gateway crash left it. */
function seedAccepted(
  acceptedMinutesAgo: number,
  state: 'accepted' | 'running' = 'accepted',
): { taskId: string; executionId: string; sessionKey: string; sessionId: string } {
  const taskId = uuidv4();
  const executionId = uuidv4();
  const sessionId = executionSessionId(AGENT_ID, executionId);
  const sessionKey = `agent:dept-marketing:${sessionId}`;
  const stamp = minutesAgo(acceptedMinutesAgo);
  run(
    `INSERT INTO tasks (id, title, status, assigned_agent_id, assignment_version, workspace_id, created_at, updated_at)
     VALUES (?, 'Orphaned dispatch', 'in_progress', ?, 0, NULL, ?, ?)`,
    [taskId, AGENT_ID, stamp, stamp],
  );
  run(
    `INSERT INTO task_executions
      (id, task_id, assignment_version, agent_id, generation, worker_context, session_key, session_id,
       state, lease_owner, lease_expires_at, idempotency_key, provider, created_at, updated_at)
     VALUES (?, ?, 0, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [executionId, taskId, AGENT_ID, WORKER_CONTEXT, sessionKey, sessionId, state, uuidv4(), stamp,
      `execution-${executionId}`, PROVIDER, stamp, stamp],
  );
  return { taskId, executionId, sessionKey, sessionId };
}

const stateOf = (executionId: string) =>
  queryOne<{ state: string; error_code: string | null; idempotency_key: string; updated_at: string }>(
    'SELECT state, error_code, idempotency_key, updated_at FROM task_executions WHERE id = ?',
    [executionId],
  );
const statusOf = (taskId: string) =>
  queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])?.status;
/** The audited in_progress → review move itself, so the assertion survives the
 *  auto-QC that immediately re-routes the card out of review. */
const movedToReview = (taskId: string) =>
  (queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND from_status = 'in_progress' AND to_status = 'review'`,
    [taskId],
  )?.n ?? 0) > 0;
const activityCount = (taskId: string) =>
  queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM task_activities WHERE task_id = ? AND activity_type = 'execution_reconciled_from_gateway'`,
    [taskId],
  )?.n ?? 0;
/** What reserveExecution() counts: the provider pool, the worker and the task
 *  slot are all COUNTS over the same ACTIVE state set. */
const activeSlotsFor = (provider: string) =>
  queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM task_executions WHERE provider = ? AND state IN ${ACTIVE_EXECUTION_STATES_SQL}`,
    [provider],
  )?.n ?? 0;

/** Only this test's row is in the pool on any given run. */
function onlyRow(executionId: string): void {
  run(`UPDATE task_executions SET state = 'succeeded' WHERE state IN ('accepted','running') AND id <> ?`, [executionId]);
}

const noHistory = async (): Promise<RawHistoryMessage[]> => [];
const noSessions = async (): Promise<RawSessionEntry[]> => [];

// ── the window ──────────────────────────────────────────────────────────────

test('an accepted row inside the stall window is left exactly as it was', async () => {
  const { taskId, executionId } = seedAccepted(3); // inside the 15-minute default
  onlyRow(executionId);
  let probed = false;
  const result = await reconcileStalledExecutions({
    reader: async () => { probed = true; return []; },
    sessions: noSessions,
    gatewayConnected: true,
  });
  assert.equal(probed, false, 'a young row is not even probed');
  assert.equal(result.waiting, 1);
  assert.equal(result.failed, 0);
  assert.equal(stateOf(executionId)?.state, 'accepted');
  assert.equal(statusOf(taskId), 'in_progress');
  assert.equal(activityCount(taskId), 0);
});

test('ACCEPTED_STALL_AFTER_MS widens the window (the control for the fail case)', async () => {
  const { executionId } = seedAccepted(90);
  onlyRow(executionId);
  process.env.ACCEPTED_STALL_AFTER_MS = String(24 * 60 * 60 * 1000);
  try {
    assert.equal(acceptedStallAfterMs(), 24 * 60 * 60 * 1000);
    const result = await reconcileStalledExecutions({ reader: noHistory, sessions: noSessions, gatewayConnected: true });
    assert.equal(result.waiting, 1);
    assert.equal(result.failed, 0);
  } finally {
    delete process.env.ACCEPTED_STALL_AFTER_MS;
  }
  assert.equal(stateOf(executionId)?.state, 'accepted');
});

// ── evidence present ────────────────────────────────────────────────────────

test('an assistant message in the history → running, and the stall clock restarts', async () => {
  const { taskId, executionId, sessionKey } = seedAccepted(90);
  onlyRow(executionId);
  const before = stateOf(executionId)!.updated_at;
  const seen: string[] = [];
  const result = await reconcileStalledExecutions({
    reader: async (key) => { seen.push(key); return [{ role: 'assistant', content: 'Working on it.' }]; },
    sessions: noSessions,
    gatewayConnected: true,
  });

  assert.deepEqual(seen, [sessionKey], 'probes the execution’s own session key');
  assert.equal(result.alive, 1);
  assert.equal(result.failed, 0);
  const row = stateOf(executionId);
  assert.equal(row?.state, 'running');
  assert.equal(row?.idempotency_key, `execution-${executionId}`, 'never mints a new key');
  assert.ok(row!.updated_at > before, 'updated_at is stamped so the stall clock restarts');
  assert.equal(statusOf(taskId), 'in_progress', 'the card keeps running');
  assert.equal(activityCount(taskId), 1);
});

test('a tool event counts as activity even with no assistant message', async () => {
  const { executionId } = seedAccepted(90);
  onlyRow(executionId);
  const result = await reconcileStalledExecutions({
    reader: async () => [{ role: 'user', content: 'go' }, { type: 'tool_use', content: 'bash' }],
    sessions: noSessions,
    gatewayConnected: true,
  });
  assert.equal(result.alive, 1);
  assert.equal(stateOf(executionId)?.state, 'running');
});

test('the gateway still reporting the session live → waited on, never failed', async () => {
  const { taskId, executionId, sessionKey } = seedAccepted(90);
  onlyRow(executionId);
  const result = await reconcileStalledExecutions({
    reader: noHistory,
    sessions: async () => [{ key: sessionKey, status: 'active' }],
    gatewayConnected: true,
  });
  assert.equal(result.waiting, 1);
  assert.equal(result.failed, 0);
  assert.equal(stateOf(executionId)?.state, 'accepted');
  assert.equal(statusOf(taskId), 'in_progress');
});

// ── the session finished ────────────────────────────────────────────────────

test('sessions.list reports the session done → the card is completed to review', async () => {
  const { taskId, executionId, sessionKey } = seedAccepted(90);
  onlyRow(executionId);
  // The run finished and registered its artifact; only the report went missing.
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path) VALUES (?, ?, 'url', 'Published page', ?)`,
    [uuidv4(), taskId, 'https://example.com/the-work'],
  );

  const result = await reconcileStalledExecutions({
    reader: noHistory,
    sessions: async () => [{ key: sessionKey, status: 'done' }],
    gatewayConnected: true,
  });

  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.ok(movedToReview(taskId), 'finished work reaches QC instead of being failed');
  assert.notEqual(statusOf(taskId), 'in_progress', 'the card left in_progress on the completion path');
  assert.equal(stateOf(executionId)?.state, 'succeeded');
  assert.equal(activeSlotsFor(PROVIDER), 0, 'the provider pool slot is released');
});

test('a done session with nothing to show is NOT failed as a lost run', async () => {
  const { taskId, executionId, sessionKey } = seedAccepted(90);
  onlyRow(executionId);
  const result = await reconcileStalledExecutions({
    reader: noHistory,
    sessions: async () => [{ key: sessionKey, status: 'done' }],
    gatewayConnected: true,
  });
  assert.equal(result.completed, 0);
  assert.equal(result.waiting, 1, 'the review-evidence gate refuses; the stuck sweep owns this one');
  assert.equal(movedToReview(taskId), false);
  assert.equal(stateOf(executionId)?.state, 'accepted');
  assert.equal(statusOf(taskId), 'in_progress');
});

// ── no evidence at all: the orphan ──────────────────────────────────────────

test('no activity and no session → failed, all three slots released, card handed back', async () => {
  const { taskId, executionId } = seedAccepted(30); // the live shape: accepted 30 min ago
  onlyRow(executionId);
  assert.equal(activeSlotsFor(PROVIDER), 1, 'the orphan is holding a pool slot before the reconcile');

  const result = await reconcileStalledExecutions({ reader: noHistory, sessions: noSessions, gatewayConnected: true });

  assert.equal(result.failed, 1);
  assert.equal(result.alive, 0);
  const row = stateOf(executionId);
  assert.equal(row?.state, 'failed');
  assert.equal(row?.error_code, 'execution_gateway_run_lost');
  assert.equal(row?.idempotency_key, `execution-${executionId}`, 'never mints a new key');
  assert.equal(statusOf(taskId), 'assigned', 'the same worker gets the card back for re-dispatch');
  assert.equal(activeSlotsFor(PROVIDER), 0, 'the task, worker and provider slots are all released');
  assert.equal(activityCount(taskId), 1, 'the reconcile is named on the Activity tab');
});

test('a `running` row the gateway lost is reconciled the same way', async () => {
  const { taskId, executionId } = seedAccepted(90, 'running');
  onlyRow(executionId);
  const result = await reconcileStalledExecutions({ reader: noHistory, sessions: noSessions, gatewayConnected: true });
  assert.equal(result.failed, 1);
  assert.equal(stateOf(executionId)?.error_code, 'execution_gateway_run_lost');
  assert.equal(statusOf(taskId), 'assigned');
});

test('a reassigned card is never rewound by the reconcile', async () => {
  const { taskId, executionId } = seedAccepted(90);
  onlyRow(executionId);
  run(`UPDATE tasks SET assignment_version = 7 WHERE id = ?`, [taskId]);
  const result = await reconcileStalledExecutions({ reader: noHistory, sessions: noSessions, gatewayConnected: true });
  assert.equal(result.failed, 1, 'the ghost attempt still releases its slots');
  assert.equal(statusOf(taskId), 'in_progress', 'but the newer assignment is untouched');
});

test('gateway UNREACHABLE → nothing is concluded from a blind read', async () => {
  const { taskId, executionId } = seedAccepted(600);
  onlyRow(executionId);
  let probed = false;
  const result = await reconcileStalledExecutions({
    reader: async () => { probed = true; return []; },
    sessions: async () => { probed = true; return []; },
    gatewayConnected: false,
  });
  assert.equal(probed, false, 'an unreachable gateway is not probed at all');
  assert.equal(result.waiting, 1);
  assert.equal(result.failed, 0);
  assert.equal(stateOf(executionId)?.state, 'accepted');
  assert.equal(statusOf(taskId), 'in_progress');
});
