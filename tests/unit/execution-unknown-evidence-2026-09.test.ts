/**
 * execution-unknown-evidence-2026-09.test.ts — EVIDENCE, NOT AGE.
 *
 * A dispatch whose chat.send acknowledgement never arrived is quarantined as
 * state='unknown' and keeps holding its worker's capacity. Nothing ever asked
 * the gateway what actually happened, so the only way out was the 24-hour
 * age-out — and on a live box one such row held a department's only worker for
 * four days.
 *
 * reconcileUnknownExecutions() asks. The dispatched message embeds
 * `**Execution ID:** <id>`, so the id appearing in that session's chat.history
 * is positive proof the send landed. Absence only counts when the gateway was
 * actually reachable AND the row is older than UNKNOWN_RESOLVE_AFTER_MS.
 *
 *   node --import tsx --test tests/unit/execution-unknown-evidence-2026-09.test.ts
 */

import './_isolated-db'; // MUST be the first DB-reaching import (C8 guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { executionSessionId } from '../../src/lib/execution-attempts';
import {
  reconcileUnknownExecutions,
  type RawHistoryMessage,
} from '../../src/lib/jobs/execution-watcher';

getDb(); // apply the migration chain (agents, tasks, task_executions, task_activities).

const AGENT_ID = `agent-${uuidv4()}`;
run(`INSERT INTO agents (id, name, role, workspace_id) VALUES (?, 'Reconcile Worker', 'Department Head', NULL)`, [AGENT_ID]);

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** A task quarantined behind one `unknown` execution, as the live stall left it. */
function seedQuarantine(quarantinedMinutesAgo: number): { taskId: string; executionId: string; sessionKey: string } {
  const taskId = uuidv4();
  const executionId = uuidv4();
  const sessionId = executionSessionId(AGENT_ID, executionId);
  const sessionKey = `agent:dept-marketing:${sessionId}`;
  const stamp = minutesAgo(quarantinedMinutesAgo);
  run(
    `INSERT INTO tasks (id, title, status, assigned_agent_id, assignment_version, workspace_id, created_at, updated_at)
     VALUES (?, 'Quarantined dispatch', 'in_progress', ?, 0, NULL, ?, ?)`,
    [taskId, AGENT_ID, stamp, stamp],
  );
  run(
    `INSERT INTO task_executions
      (id, task_id, assignment_version, agent_id, generation, worker_context, session_key, session_id,
       state, lease_owner, lease_expires_at, idempotency_key, error_code, created_at, updated_at)
     VALUES (?, ?, 0, ?, 1, '[]', ?, ?, 'unknown', ?, ?, ?, 'execution_lease_expired', ?, ?)`,
    [executionId, taskId, AGENT_ID, sessionKey, sessionId, uuidv4(), stamp, `execution-${executionId}`, stamp, stamp],
  );
  return { taskId, executionId, sessionKey };
}

const stateOf = (executionId: string) =>
  queryOne<{ state: string; error_code: string | null; idempotency_key: string }>(
    'SELECT state, error_code, idempotency_key FROM task_executions WHERE id = ?',
    [executionId],
  );
const statusOf = (taskId: string) =>
  queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])?.status;
const activityCount = (taskId: string) =>
  queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM task_activities WHERE task_id = ? AND activity_type = 'execution_reconciled_from_gateway'`,
    [taskId],
  )?.n ?? 0;

/** Only this test's quarantine is in the pool on any given run. */
function onlyRow(executionId: string): void {
  run(`UPDATE task_executions SET state = 'succeeded' WHERE state = 'unknown' AND id <> ?`, [executionId]);
}

// ── evidence present ────────────────────────────────────────────────────────

test('the dispatched message IS in the history → accepted, quarantine over', async () => {
  const { taskId, executionId, sessionKey } = seedQuarantine(90);
  onlyRow(executionId);
  const seen: string[] = [];
  const reader = async (key: string): Promise<RawHistoryMessage[]> => {
    seen.push(key);
    return [{ role: 'user', content: `Do the thing.\n\n**Execution ID:** ${executionId}\n`, ts: Date.now() }];
  };

  const result = await reconcileUnknownExecutions({ reader, gatewayConnected: true });

  assert.deepEqual(seen, [sessionKey], 'probes the execution’s own session key');
  assert.equal(result.evidenced, 1);
  assert.equal(result.failed, 0);
  const row = stateOf(executionId);
  assert.equal(row?.state, 'accepted', 'no assistant reply yet → accepted');
  assert.equal(row?.error_code, null, 'the quarantine error code is cleared');
  assert.equal(row?.idempotency_key, `execution-${executionId}`, 'never mints a new key');
  assert.equal(statusOf(taskId), 'in_progress', 'the card keeps running');
  assert.equal(activityCount(taskId), 1, 'the reconcile is named on the Activity tab');
});

test('the agent has already answered in that session → running', async () => {
  const { executionId } = seedQuarantine(90);
  onlyRow(executionId);
  const reader = async (): Promise<RawHistoryMessage[]> => [
    { role: 'user', content: `**Execution ID:** ${executionId}` },
    { role: 'assistant', content: 'On it.' },
  ];
  const result = await reconcileUnknownExecutions({ reader, gatewayConnected: true });
  assert.equal(result.evidenced, 1);
  assert.equal(stateOf(executionId)?.state, 'running');
});

test('a gateway that returns content as blocks is read the same way', async () => {
  const { executionId } = seedQuarantine(90);
  onlyRow(executionId);
  const reader = async (): Promise<RawHistoryMessage[]> => [
    { role: 'user', content: [{ type: 'text', text: `**Execution ID:** ${executionId}` }] } as unknown as RawHistoryMessage,
  ];
  const result = await reconcileUnknownExecutions({ reader, gatewayConnected: true });
  assert.equal(result.evidenced, 1);
  assert.equal(stateOf(executionId)?.state, 'accepted');
});

// ── no evidence ─────────────────────────────────────────────────────────────

test('no evidence but the row is YOUNG → left exactly as it was', async () => {
  const { taskId, executionId } = seedQuarantine(3); // inside the 15-minute window
  onlyRow(executionId);
  const result = await reconcileUnknownExecutions({ reader: async () => [], gatewayConnected: true });
  assert.equal(result.waiting, 1);
  assert.equal(result.failed, 0);
  assert.equal(stateOf(executionId)?.state, 'unknown', 'a late acknowledgement is still plausible');
  assert.equal(statusOf(taskId), 'in_progress');
  assert.equal(activityCount(taskId), 0);
});

test('no evidence, gateway reachable, past the window → failed and the card is handed back', async () => {
  const { taskId, executionId } = seedQuarantine(90);
  onlyRow(executionId);
  const result = await reconcileUnknownExecutions({ reader: async () => [], gatewayConnected: true });
  assert.equal(result.failed, 1);
  const row = stateOf(executionId);
  assert.equal(row?.state, 'failed');
  assert.equal(row?.error_code, 'execution_unknown_no_evidence');
  assert.equal(row?.idempotency_key, `execution-${executionId}`, 'never mints a new key');
  assert.equal(statusOf(taskId), 'assigned', 'the same worker gets the card back');
  assert.equal(activityCount(taskId), 1);
});

test('a reassigned card is never rewound by the reconcile', async () => {
  const { taskId, executionId } = seedQuarantine(90);
  onlyRow(executionId);
  // The operator moved the card on; assignment_version no longer matches the row.
  run(`UPDATE tasks SET assignment_version = 7 WHERE id = ?`, [taskId]);
  const result = await reconcileUnknownExecutions({ reader: async () => [], gatewayConnected: true });
  assert.equal(result.failed, 1, 'the ghost attempt still releases its worker slot');
  assert.equal(statusOf(taskId), 'in_progress', 'but the newer assignment is untouched');
});

test('gateway UNREACHABLE → nothing is concluded from a blind read', async () => {
  const { taskId, executionId } = seedQuarantine(600);
  onlyRow(executionId);
  let probed = false;
  const result = await reconcileUnknownExecutions({
    reader: async () => {
      probed = true;
      return [];
    },
    gatewayConnected: false,
  });
  assert.equal(probed, false, 'an unreachable gateway is not probed at all');
  assert.equal(result.waiting, 1);
  assert.equal(result.failed, 0);
  assert.equal(stateOf(executionId)?.state, 'unknown', 'the 24h backstop keeps this one');
  assert.equal(statusOf(taskId), 'in_progress');
});

test('UNKNOWN_RESOLVE_AFTER_MS widens the window (the control for the fail case)', async () => {
  const { executionId } = seedQuarantine(90);
  onlyRow(executionId);
  process.env.UNKNOWN_RESOLVE_AFTER_MS = String(24 * 60 * 60 * 1000);
  try {
    const result = await reconcileUnknownExecutions({ reader: async () => [], gatewayConnected: true });
    assert.equal(result.waiting, 1);
    assert.equal(result.failed, 0);
  } finally {
    delete process.env.UNKNOWN_RESOLVE_AFTER_MS;
  }
  assert.equal(stateOf(executionId)?.state, 'unknown');
});
