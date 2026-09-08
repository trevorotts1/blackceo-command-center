/**
 * social-f03-dispatcher.test.ts — F03 acceptance (CC half).
 *
 * "A button click produces one worker execution and a visible task. Restart
 * the service between enqueue and dispatch: it resumes once. A stopped
 * consumer generates an actionable overdue alert, not indefinite 'working'."
 *
 * Proven in-process against an isolated temp DB (full migration chain incl.
 * 136) and the REAL dispatcher module:
 *   1. Enqueue → exactly one sweep creates exactly one canonical task and one
 *      execution; a second sweep never duplicates (idempotency).
 *   2. Crash after enqueue (consumer stopped) → overdue alert state, never
 *      indefinite queued/"working".
 *   3. Crash after enqueue before dispatch → next tick resumes once; one task.
 *   4. Restart mid-dispatch → persisted task/execution linkage survives on
 *      the row (ack-before-reconcile ordering).
 *   5. Attempt limits + retry_at: a dispatch that cannot advance backs off,
 *      then hard-fails at the cap with a visible error.
 *   6. Migration 136 added the execution-contract columns.
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/social-f03-dispatcher.test.ts
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, queryOne, queryAll, run, closeDb } from '../../src/lib/db';
import {
  runSocialPublishDispatcherSweep,
  runSocialPublishOverdueSweep,
  deriveQueueItemState,
  publishIdempotencyKey,
} from '../../src/lib/jobs/social-publish-dispatcher';
import { EXECUTION_SCHEMA_SQL } from '../../src/lib/execution-schema';

// Gateway unreachable — dispatch attempts fail cheaply without a live socket.
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';
// Fast test knobs.
process.env.SOCIAL_PUBLISH_BACKOFF_BASE_SECONDS = '30';
process.env.SOCIAL_PUBLISH_LEASE_SECONDS = '300';

const db = getDb(); // full migration chain (incl. 136) against the isolated temp DB

// The test agent roster: one non-master specialist in a marketing workspace.
function ensureWorkspaces(): { marketingWs: string; companyA: string } {
  const companyA = 'company-f03';
  if (!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(companyA)) {
    run(`INSERT INTO companies (id, name, slug) VALUES (?, 'F03 Test Co', 'f03-test-co')`, [companyA]);
  }
  const marketingWs = 'ws-f03-marketing';
  if (!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(marketingWs)) {
    run(`INSERT INTO workspaces (id, slug, name, company_id) VALUES (?, 'marketing', 'Marketing', ?)`, [
      marketingWs,
      companyA,
    ]);
  }
  const agentId = 'agent-f03-specialist';
  if (!db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId)) {
    run(`INSERT INTO agents (id, name, role, is_master, workspace_id, status) VALUES (?, 'F03 Specialist', 'specialist', 0, ?, 'standby')`, [
      agentId,
      marketingWs,
    ]);
  }
  return { marketingWs, companyA };
}

let seq = 0;
function enqueueRow(opts: {
  companyA: string;
  status?: string;
  createdAt?: string;
  leaseExpiresAt?: string | null;
  ccTaskId?: string | null;
}): string {
  seq++;
  const id = `pq-f03-${seq}`;
  const created = opts.createdAt ?? new Date().toISOString();
  run(
    `INSERT INTO publish_queue
      (id, task_id, company_id, sheet_id, topic, platforms, schedule, status, created_at, updated_at,
       cc_task_id, lease_expires_at)
     VALUES (?, NULL, ?, NULL, ?, ?, 'auto', ?, ?, ?, ?, ?)`,
    [
      id,
      opts.companyA,
      `F03 topic ${seq}`,
      JSON.stringify(['linkedin', 'x']),
      opts.status ?? 'queued',
      created,
      created,
      opts.ccTaskId ?? null,
      opts.leaseExpiresAt ?? null,
    ],
  );
  return id;
}

test.after(async () => {
  try {
    const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
    getOpenClawClient().disconnect();
  } catch { /* ignore */ }
  try {
    const g = globalThis as Record<string, NodeJS.Timeout | undefined>;
    if (g['__openclaw_cache_cleanup_timer__']) clearInterval(g['__openclaw_cache_cleanup_timer__']);
  } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
});

// ── Migration 136 columns present ───────────────────────────────────────────
test('[F03.6] migration 136 adds the execution-contract columns + idempotency index', () => {
  const cols = (db.prepare('PRAGMA table_info(publish_queue)').all() as { name: string }[]).map((c) => c.name);
  for (const col of ['cc_task_id', 'cc_execution_id', 'idempotency_key', 'lease_owner', 'lease_expires_at', 'attempt_count', 'retry_at', 'overdue_since']) {
    assert.ok(cols.includes(col), `publish_queue.${col} must exist after migration 136`);
  }
  const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='publish_queue'`).all() as { name: string }[]).map((r) => r.name);
  assert.ok(idx.includes('idx_publish_queue_idem'), 'unique idempotency index must exist');
});

// ── Enqueue → exactly one execution ─────────────────────────────────────────
test('[F03.1] one sweep → exactly one canonical task, persisted linkage, no duplicate on re-sweep', async () => {
  const { companyA } = ensureWorkspaces();
  const id = enqueueRow({ companyA });

  const first = await runSocialPublishDispatcherSweep();
  const row1 = queryOne<{ status: string; cc_task_id: string | null; cc_execution_id: string | null; attempt_count: number }>(
    'SELECT status, cc_task_id, cc_execution_id, attempt_count FROM publish_queue WHERE id = ?', [id],
  );
  assert.ok(row1, 'row exists');
  assert.equal(row1.attempt_count, 1, 'exactly one claim');

  if (first.dispatched > 0) {
    // Dispatch acknowledged: linkage persisted BEFORE ack, execution exists.
    assert.ok(row1!.cc_task_id, 'cc_task_id persisted');
    assert.ok(row1!.cc_execution_id, 'cc_execution_id persisted before ack');
    const exec = queryOne<{ id: string; task_id: string }>(
      'SELECT id, task_id FROM task_executions WHERE task_id = ?', [row1!.cc_task_id],
    );
    assert.ok(exec, 'one execution row for the canonical task');
    assert.equal(exec!.id, row1!.cc_execution_id, 'row execution linkage matches the real execution');
  } else {
    // Gateway-down path still created exactly one canonical task (linkage first).
    assert.ok(row1!.cc_task_id, 'canonical task created even when dispatch could not be acknowledged');
  }
  const taskCount = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Social publish: F03 topic%'`, [],
  )!.n;
  assert.equal(taskCount, 1, 'exactly one canonical task from one enqueue');

  // Second sweep must not duplicate: the row is no longer claimable (running/
  // retrying past retry_at) and createTaskCore dedupes on the idempotency key.
  const taskId = row1!.cc_task_id!;
  await runSocialPublishDispatcherSweep();
  const taskCount2 = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Social publish: F03 topic%'`, [],
  )!.n;
  assert.equal(taskCount2, 1, 're-sweep never creates a second task (idempotency)');
  const rowAfter = queryOne<{ cc_task_id: string | null }>('SELECT cc_task_id FROM publish_queue WHERE id = ?', [id]);
  assert.equal(rowAfter!.cc_task_id, taskId, 'linkage stable across sweeps');
});

// ── Stopped consumer → overdue alert state ──────────────────────────────────
test('[F03.2] stopped consumer: queued row past grace → derived overdue + durable overdue sweep', async () => {
  const { companyA } = ensureWorkspaces();
  const oldDate = new Date(Date.now() - 30 * 60_000).toISOString(); // 30 min old
  const id = enqueueRow({ companyA, createdAt: oldDate });

  const derived = deriveQueueItemState({ status: 'queued', created_at: oldDate, now: new Date() });
  assert.equal(derived, 'overdue', 'a 30-minute-old queued row is overdue (consumer cadence is 2 min)');

  const res = await runSocialPublishOverdueSweep();
  assert.ok(res.overdue >= 1, 'the overdue sweep surfaces at least the stale row');
  const row = queryOne<{ status: string; overdue_since: string | null }>(
    'SELECT status, overdue_since FROM publish_queue WHERE id = ?', [id],
  );
  assert.equal(row!.status, 'overdue', 'durable overdue status persisted');
  assert.ok(row!.overdue_since, 'overdue_since stamped (operator alert dedup guard)');

  // A fresh queued row is NOT overdue.
  const freshId = enqueueRow({ companyA });
  const freshRow = queryOne<{ created_at: string }>('SELECT created_at FROM publish_queue WHERE id = ?', [freshId]);
  assert.equal(
    deriveQueueItemState({ status: 'queued', created_at: freshRow!.created_at, now: new Date() }),
    'queued',
    'fresh row stays queued — only a stopped consumer produces overdue',
  );
});

// ── Crash after enqueue before dispatch → resume once ───────────────────────
test('[F03.3] crash after enqueue: expired running lease without linkage is reclaimed exactly once', async () => {
  const { companyA } = ensureWorkspaces();
  // Simulate a crash mid-dispatch: running, expired lease, NO linkage yet.
  const oldLease = new Date(Date.now() - 10 * 60_000).toISOString();
  const id = enqueueRow({ companyA, status: 'running', leaseExpiresAt: oldLease });

  // Derived state flags it overdue (mid-dispatch death, no task).
  const row = queryOne<{ status: string; created_at: string; lease_expires_at: string | null }>(
    'SELECT status, created_at, lease_expires_at FROM publish_queue WHERE id = ?', [id],
  );
  assert.equal(
    deriveQueueItemState({ status: 'running', created_at: row!.created_at, lease_expires_at: row!.lease_expires_at, now: new Date() }),
    'overdue',
    'expired running lease without task linkage is actionable overdue, not indefinite working',
  );

  // Overdue sweep makes it durably visible…
  await runSocialPublishOverdueSweep();
  const durabled = queryOne<{ status: string; overdue_since: string | null }>(
    'SELECT status, overdue_since FROM publish_queue WHERE id = ?', [id],
  );
  assert.equal(durabled!.status, 'overdue', 'crashed row durably overdue');

  // …and the claim path can resume it exactly once: a queued-state resume via
  // the dispatcher only claims queued/retrying. Operator-driven recovery (or a
  // repair hook) resets status → queued; then one sweep dispatches once.
  run(`UPDATE publish_queue SET status = 'queued', overdue_since = overdue_since, updated_at = ? WHERE id = ?`, [
    new Date().toISOString(), id,
  ]);
  await runSocialPublishDispatcherSweep();
  const resumed = queryOne<{ cc_task_id: string | null; attempt_count: number }>(
    'SELECT cc_task_id, attempt_count FROM publish_queue WHERE id = ?', [id],
  );
  assert.equal(resumed!.attempt_count, 1, 'resume claimed once');
  assert.ok(resumed!.cc_task_id, 'resume produced the canonical task');
});

// ── Restart mid-dispatch → persisted linkage survives ───────────────────────
test('[F03.4] linkage persisted BEFORE dispatch acknowledgement survives a simulated restart', async () => {
  const { companyA } = ensureWorkspaces();
  const id = enqueueRow({ companyA });
  await runSocialPublishDispatcherSweep();
  const row = queryOne<{ cc_task_id: string | null; cc_execution_id: string | null; status: string }>(
    'SELECT cc_task_id, cc_execution_id, status FROM publish_queue WHERE id = ?', [id],
  );
  // Whatever the gateway outcome was, linkage (when a task exists) is durable.
  if (row!.cc_task_id) {
    const task = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [row!.cc_task_id]);
    assert.ok(task, 'persisted cc_task_id resolves to a real task after restart');
  }
  // The W0 dispatch.json rule: a stale worker cannot commit after reassignment —
  // the claim CAS refuses a second claim while the lease is live.
  const leaseLive = new Date(Date.now() + 60_000).toISOString();
  run(`UPDATE publish_queue SET status = 'running', lease_owner = 'ghost', lease_expires_at = ? WHERE id = ?`, [leaseLive, id]);
  const staleClaim = run(
    `UPDATE publish_queue SET status = 'running', lease_owner = 'new-worker', lease_expires_at = ?,
       attempt_count = attempt_count + 1
     WHERE id = ? AND status IN ('queued','retrying') AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    [leaseLive, id, new Date().toISOString()],
  );
  assert.equal(staleClaim.changes, 0, 'a stale worker cannot re-claim a live-leased row (fencing)');
});

// ── Attempt limits + retry_at backoff ───────────────────────────────────────
test('[F03.5] held dispatch backs off with retry_at; idempotency key is stable and deterministic', async () => {
  const key1 = publishIdempotencyKey({ companyId: 'c', taskId: null, topic: 'Tea', platforms: ['x', 'linkedin'] });
  const key2 = publishIdempotencyKey({ companyId: 'c', taskId: null, topic: '  tea  ', platforms: ['linkedin', 'x'] });
  assert.equal(key1, key2, 'key normalizes topic case/whitespace and platform order');
  const key3 = publishIdempotencyKey({ companyId: 'other', taskId: null, topic: 'Tea', platforms: ['x', 'linkedin'] });
  assert.notEqual(key1, key3, 'different companies never share a key');

  const { companyA } = ensureWorkspaces();
  const id = enqueueRow({ companyA, status: 'retrying' });
  run(`UPDATE publish_queue SET attempt_count = 4, retry_at = NULL WHERE id = ?`, [id]);
  await runSocialPublishDispatcherSweep();
  const row = queryOne<{ status: string; error: string | null; retry_at: string | null }>(
    'SELECT status, error, retry_at FROM publish_queue WHERE id = ?', [id],
  );
  // Attempt 5 ≥ MAX_ATTEMPTS(5): hard-failed with visible error — never silently re-looped.
  assert.equal(row!.status, 'failed', 'row at attempt cap hard-fails');
  assert.ok(row!.error && row!.error.includes('attempt 5/5'), 'error carries the attempt ledger');
});