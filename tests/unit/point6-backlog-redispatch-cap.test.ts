/**
 * Point 6 fix 2 — backlog re-dispatch escalation cap.
 *
 * A task the cheap re-dispatch loop can never advance (config problem / SOP-hold
 * that never clears — paths that never go through recordDispatchFailure) was
 * re-fired forever: no furnace, but also no escalation. Mirroring the QC cap:
 * after REDISPATCH_MAX_ATTEMPTS (K) retries AND the task has been stuck for at
 * least REDISPATCH_ESCALATE_HOURS (M), the sweep escalates it to `blocked` with a
 * [REDISPATCH-CAP] operator-feed note (SYSTEM audience).
 *
 * Coverage:
 *   1. over cap + stuck ≥ M hours → escalated to blocked, [REDISPATCH-CAP] event,
 *      block_audience SYSTEM, result.escalated counted.
 *   2. below cap (but old) → NOT escalated (K guard); counter incremented.
 *   3. over cap but NOT old enough → NOT escalated (M guard); counter incremented.
 *
 * Isolated temp DB. Gateway is unreachable (ws://127.0.0.1:18789 refused fast),
 * so the non-escalated dispatch attempts fail cheaply without a real connection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-redispatch-cap-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Point the gateway at a DELIBERATELY invalid URL BEFORE any import. In
// OpenClawClient.connect(), `new URL(this.url)` runs before any socket is created,
// so an invalid URL makes connect() reject synchronously with ZERO open handles /
// timers. This keeps the non-escalated re-dispatch attempts hermetic (no live
// local gateway on the operator box, no lingering WebSocket keeping the process
// alive) — autoDispatchTask just records a cheap failed attempt and returns.
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';

// Small, fast cap for the test: K=2 retries over M=1 hour.
process.env.REDISPATCH_MAX_ATTEMPTS = '2';
process.env.REDISPATCH_ESCALATE_HOURS = '1';
// SWEEP-01: the backlog-redispatch sweep is now PAUSED BY DEFAULT (opt-in) —
// intake-advance-sweep is the single live advancer. This test exercises the
// sweep's escalation-cap LOGIC (orthogonal to whether it runs by default), so
// it must explicitly opt in; otherwise runBacklogRedispatchSweep() returns early
// as paused and nothing escalates.
process.env.BACKLOG_REDISPATCH_SWEEP_ENABLED = '1';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type SweepModule = typeof import('../../src/lib/jobs/backlog-redispatch-sweep');
let runBacklogRedispatchSweep: SweepModule['runBacklogRedispatchSweep'];

const AGENT_ID = 'agent-redispatch-cap';

/** Insert a stuck backlog task assigned to the shared non-master agent. */
function insertStuckTask(
  id: string,
  opts: { redispatchCount: number; ageHours: number },
) {
  const updatedAt = new Date(Date.now() - opts.ageHours * 3600 * 1000).toISOString();
  const createdAt = updatedAt;
  run(
    `INSERT INTO tasks
       (id, title, description, status, priority, assigned_agent_id, workspace_id, business_id,
        dispatch_attempts, qc_reroute_attempts, redispatch_count, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', ?, NULL, NULL, 0, 0, ?, ?, ?)`,
    [id, `Stuck task ${id}`, 'Cannot advance — simulated permanent hold.', AGENT_ID, opts.redispatchCount, createdAt, updatedAt],
  );
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // run migrations (incl. 084 redispatch_count)

  // A non-master specialist agent (workspace_id NULL → no FK dependency).
  run(
    `INSERT INTO agents (id, name, role, is_master, workspace_id) VALUES (?, ?, ?, 0, NULL)`,
    [AGENT_ID, 'Redispatch Cap Agent', 'specialist'],
  );

  const sweep = await import('../../src/lib/jobs/backlog-redispatch-sweep');
  runBacklogRedispatchSweep = sweep.runBacklogRedispatchSweep;
});

test.after(async () => {
  delete process.env.REDISPATCH_MAX_ATTEMPTS;
  delete process.env.REDISPATCH_ESCALATE_HOURS;
  // Close the OpenClaw client the non-escalated dispatch attempts opened AND clear
  // its shared, non-unref'd periodic cache-cleanup interval (stored on globalThis
  // under '__openclaw_cache_cleanup_timer__'); disconnect() does not clear it, so
  // it would otherwise keep the test process alive at exit.
  try {
    const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
    getOpenClawClient().disconnect();
  } catch { /* ignore */ }
  try {
    const g = globalThis as Record<string, NodeJS.Timeout | undefined>;
    const timer = g['__openclaw_cache_cleanup_timer__'];
    if (timer) {
      clearInterval(timer);
      delete g['__openclaw_cache_cleanup_timer__'];
    }
  } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

// ── 1: over cap + stuck ≥ M hours → escalated to blocked ────────────────────
test('[Point6.2a] over cap + stuck ≥ M hours → escalated to blocked with [REDISPATCH-CAP]', async () => {
  const id = 'redis-escalate';
  insertStuckTask(id, { redispatchCount: 2, ageHours: 2 }); // count 2 >= cap 2, stuck 2h >= 1h

  const res = await runBacklogRedispatchSweep();
  assert.ok((res.escalated ?? 0) >= 1, `at least one task must be escalated (escalated=${res.escalated})`);

  const task = queryOne<{ status: string; block_audience: string | null; block_reason: string | null }>(
    'SELECT status, block_audience, block_reason FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(task!.status, 'blocked', 'capped task must be escalated to blocked');
  assert.equal(task!.block_audience, 'SYSTEM', 'redispatch-cap block audience must be SYSTEM (operator, not client)');

  const capEvt = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND message LIKE '%[REDISPATCH-CAP]%' LIMIT 1`,
    [id],
  );
  assert.ok(capEvt, 'a [REDISPATCH-CAP] operator-feed event must be written');
});

// ── 2: below cap (but old) → NOT escalated, counter incremented ─────────────
test('[Point6.2b] below cap → NOT escalated even when old (K guard); counter increments', async () => {
  const id = 'redis-belowcap';
  insertStuckTask(id, { redispatchCount: 0, ageHours: 2 }); // count 0 < cap 2, though 2h old

  await runBacklogRedispatchSweep();

  const capEvt = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND message LIKE '%[REDISPATCH-CAP]%' LIMIT 1`,
    [id],
  );
  assert.ok(!capEvt, 'below-cap task must NOT be escalated');

  const task = queryOne<{ status: string; redispatch_count: number | null }>(
    'SELECT status, redispatch_count FROM tasks WHERE id = ?',
    [id],
  );
  assert.notEqual(task!.status, 'blocked', 'below-cap task must not be blocked by the redispatch cap');
  assert.equal(task!.redispatch_count, 1, 'the cheap-retry counter must increment on a non-escalated re-dispatch');
});

// ── 3: over cap but NOT old enough → NOT escalated, counter incremented ──────
test('[Point6.2c] over cap but stuck < M hours → NOT escalated (M guard); counter increments', async () => {
  const id = 'redis-notold';
  // count 5 >= cap 2, but only 5 minutes old (> 2-min grace, < 1h escalate window).
  insertStuckTask(id, { redispatchCount: 5, ageHours: 5 / 60 });

  await runBacklogRedispatchSweep();

  const capEvt = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND message LIKE '%[REDISPATCH-CAP]%' LIMIT 1`,
    [id],
  );
  assert.ok(!capEvt, 'task not yet stuck for M hours must NOT be escalated');

  const task = queryOne<{ status: string; redispatch_count: number | null }>(
    'SELECT status, redispatch_count FROM tasks WHERE id = ?',
    [id],
  );
  assert.notEqual(task!.status, 'blocked', 'not-old-enough task must not be blocked by the redispatch cap');
  assert.equal(task!.redispatch_count, 6, 'the cheap-retry counter must increment (5 → 6) without escalating');
});
