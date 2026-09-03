/**
 * stale-sweep-qc-cap-bounce-loop.test.ts — LOOP-FIX-20260903.
 *
 * THE INCIDENT this pins (live, task 8a814fca-a6f9-498a-b07c-7f35e9935b27):
 *   Aug 11 — 4 legitimate QC-FAIL cycles hit QC_MAX_REROUTES (3) at 4/3 →
 *            blocked, blocked_on_human=operator.
 *   Aug 17 — stale-task-sweep's blocked-branch return threshold (6h) fired
 *            and bounced it back to `backlog` via returnToOrchestrator(),
 *            which increments qc_reroute_attempts UNCONDITIONALLY — even
 *            though no QC ran. 4 → 5.
 *   Sep 03 13:18:08 — intake-advance-sweep's cap-out surfacing
 *            (LOOP-FIX-20260827) found qc_reroute_attempts (5) >= cap (3) and
 *            re-blocked it.
 *   Sep 03 13:20:00 — stale-task-sweep bounced it back to `backlog` again
 *            (same 6h-return logic, blind to the cap); intake-advance-sweep
 *            re-blocked it the same second. 6/3.
 *   The two sweeps hold contradictory policies with no precedence rule, and
 *   the counter inflates on every bounce though no QC ever runs.
 *
 * THE FIX: stale-task-sweep's blocked-branch return threshold now checks
 * whether qc_reroute_attempts is already at/over the QC-reroute cap. If so,
 * it does NOT call returnToOrchestrator (which is what both breaks the board
 * out of the blocked lane AND increments the counter) — instead it writes a
 * ONE-TIME (deduped) `stale_blocked_over_cap_hold` escalation and leaves the
 * task exactly where it is: `blocked`, visible, untouched counter.
 *
 * A blocked task UNDER the cap is completely unaffected — returnToOrchestrator
 * still fires at the return threshold exactly as before (REGRESSION GUARD).
 *
 * Escalations are counted end-to-end the same way stale-blocked-reping-dedup
 * does: a local HTTP server stands in for the Rescue Rangers webhook so
 * assertions are on messages that ACTUALLY left the process.
 *
 *   node --import tsx --test tests/unit/stale-sweep-qc-cap-bounce-loop.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1'; // RUNG 2 (operator Telegram) off — webhook only.
delete process.env.DISABLE_STALE_TASK_SWEEP;
delete process.env.STALE_REPING_DEDUP_HOURS; // exercise the 24h default
delete process.env.STALE_OVER_CAP_HOLD_DEDUP_HOURS; // exercise the 24h default
process.env.QC_MAX_REROUTES = '3'; // matches the shipped default — explicit for a deterministic fixture

import './_isolated-db'; // MUST be first.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { v4 as uuidv4 } from 'uuid';
import { run, queryOne } from '../../src/lib/db';
import { runStaleTaskSweep } from '../../src/lib/jobs/stale-task-sweep';

// ── The escalation sink: every message that actually leaves the process ──────────
let server: http.Server;
/** POSTs to the Rescue-Rangers-style webhook — the OPERATOR escalation path. */
let operatorEscalations: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url?.startsWith('/rescue')) operatorEscalations.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.RESCUE_RANGERS_WEBHOOK_URL = `http://127.0.0.1:${port}/rescue`;
  process.env.MISSION_CONTROL_URL = `http://127.0.0.1:${port}`;
  // SAFETY-06 gates the operator escalation webhook off in a test run by default;
  // this suite's whole point is to COUNT it, and the webhook already points at its
  // OWN 127.0.0.1 sink above.
  process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
});

after(async () => {
  delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
  delete process.env.MISSION_CONTROL_URL;
  delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
  delete process.env.QC_MAX_REROUTES;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  operatorEscalations = [];
});

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

/**
 * A blocked task, seeded with a specific qc_reroute_attempts value and age.
 * blocked_reason is CHECK-constrained to ('decision','approval','credential',
 * 'payment'); ask must be non-empty (migration-104 invariant).
 */
function seedBlockedTask(opts: { qcAttempts: number; ageHours: number; who?: 'operator' | 'owner' }): string {
  const id = uuidv4();
  const wsId = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [
    wsId,
    'operations',
    `operations-${uuidv4().slice(0, 8)}`,
  ]);
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, blocked_on_human, blocked_reason, ask, updated_at, last_progress_at, qc_reroute_attempts)
     VALUES (?, ?, 'blocked', ?, ?, 'decision', 'Awaiting a human decision (fixture)', ?, ?, ?)`,
    [
      id,
      `Blocked task ${id.slice(0, 8)}`,
      wsId,
      opts.who ?? 'operator',
      hoursAgo(opts.ageHours),
      hoursAgo(opts.ageHours),
      opts.qcAttempts,
    ],
  );
  return id;
}

function escalationsFor(taskId: string, sink: string[]): number {
  return sink.filter((body) => body.includes(taskId)).length;
}

function overCapHoldEventCount(taskId: string): number {
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'stale_blocked_over_cap_hold'`,
    [taskId],
  );
  return row?.n ?? 0;
}

function taskRow(taskId: string) {
  return queryOne<{ status: string; qc_reroute_attempts: number | null }>(
    `SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?`,
    [taskId],
  );
}

/** notifySystem() fire-and-forgets; poll rather than sleep blind. */
async function settle(expected: number, sink: () => string[], timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (sink().length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 120));
}

// ── 1. THE LOOP IS BROKEN ─────────────────────────────────────────────────────
test('LOOP BROKEN: an over-cap blocked task past the return threshold is NEVER returned to backlog', async () => {
  // qcAttempts=5 >= cap(3), ageHours=8 > the 6h return threshold.
  const id = seedBlockedTask({ qcAttempts: 5, ageHours: 8 });

  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(await runStaleTaskSweep());
  }
  await settle(1, () => operatorEscalations);

  const task = taskRow(id);
  assert.equal(task?.status, 'blocked', 'an over-cap blocked task must stay blocked, never bounced to backlog');
  for (const r of results) {
    assert.equal(r.returned, 0, 'the over-cap task must never be counted as `returned`');
  }
});

// ── 2. REGRESSION GUARD (mandatory): under-cap behavior is unchanged ─────────
test('REGRESSION GUARD: a blocked task UNDER the cap is still returned to backlog past the return threshold', async () => {
  // qcAttempts=1 < cap(3), ageHours=8 > the 6h return threshold.
  const id = seedBlockedTask({ qcAttempts: 1, ageHours: 8 });

  const result = await runStaleTaskSweep();
  assert.equal(result.returned, 1, 'the under-cap task must still be counted as returned — existing behavior preserved');

  const task = taskRow(id);
  assert.equal(task?.status, 'backlog', 'an under-cap blocked task is still returned to backlog exactly as before the fix');
});

// ── 3. qc_reroute_attempts does NOT inflate on a cap re-check ────────────────
test('COUNTER: qc_reroute_attempts does NOT increment across repeated ticks once a task is over cap', async () => {
  const id = seedBlockedTask({ qcAttempts: 4, ageHours: 8 }); // 4 >= cap(3)

  for (let i = 0; i < 6; i++) {
    await runStaleTaskSweep();
  }
  await settle(1, () => operatorEscalations);

  const task = taskRow(id);
  assert.equal(task?.qc_reroute_attempts, 4, 'no QC ran and no return happened — the counter must not move');
  assert.equal(task?.status, 'blocked', 'still blocked after 6 ticks');

  // Even after the escalation dedup window ages out and the hold re-announces,
  // the counter is STILL untouched — the hold path never touches it, only
  // returnToOrchestrator does, and that path is never reached for this task.
  run(`UPDATE events SET created_at = ? WHERE task_id = ? AND type = 'stale_blocked_over_cap_hold'`, [
    hoursAgo(25),
    id,
  ]);
  await runStaleTaskSweep();
  await settle(2, () => operatorEscalations);
  const taskAfterReescalation = taskRow(id);
  assert.equal(taskAfterReescalation?.qc_reroute_attempts, 4, 'the counter is still untouched after a second escalation window');
});

// ── 4. qc_reroute_attempts DOES still increment on a genuine reroute ─────────
test('COUNTER: qc_reroute_attempts DOES still increment on a genuine (under-cap) return-to-orchestrator', async () => {
  const id = seedBlockedTask({ qcAttempts: 2, ageHours: 8 }); // under cap(3)

  const result = await runStaleTaskSweep();
  assert.equal(result.returned, 1);

  const task = taskRow(id);
  assert.equal(task?.qc_reroute_attempts, 3, 'a genuine return-to-orchestrator still bumps the counter — unchanged contract');
  assert.equal(task?.status, 'backlog');
});

// ── 5. Escalation fires once, deduped — not once per tick ────────────────────
test('ESCALATE ONCE: the over-cap hold fires once per dedup window, not once per tick, and re-fires on the next window (not muted)', async () => {
  const id = seedBlockedTask({ qcAttempts: 4, ageHours: 8 });

  for (let i = 0; i < 5; i++) await runStaleTaskSweep();
  await settle(1, () => operatorEscalations);

  assert.equal(escalationsFor(id, operatorEscalations), 1, 'exactly one escalation across 5 ticks, not 5');
  assert.equal(overCapHoldEventCount(id), 1, 'exactly one dedup key row written across 5 ticks');

  // Age the dedup key out — a still-stuck over-cap task must escalate again
  // (CAP, not MUTE — same anti-silence contract as wasRecentlyRepinged).
  run(`UPDATE events SET created_at = ? WHERE task_id = ? AND type = 'stale_blocked_over_cap_hold'`, [
    hoursAgo(25),
    id,
  ]);
  await runStaleTaskSweep();
  await settle(2, () => operatorEscalations);
  assert.equal(
    escalationsFor(id, operatorEscalations),
    2,
    'a still-stuck over-cap task escalates again once the dedup window passes',
  );

  // And the counter is STILL untouched by any of this.
  assert.equal(taskRow(id)?.qc_reroute_attempts, 4, 'escalating never touches the counter');
});

test('ESCALATE ONCE: the dedup guard FAILS OPEN — a throwing query escalates anyway', async () => {
  const id = seedBlockedTask({ qcAttempts: 4, ageHours: 8 });

  await runStaleTaskSweep();
  await settle(1, () => operatorEscalations);
  assert.equal(escalationsFor(id, operatorEscalations), 1, 'baseline: one escalation');

  await runStaleTaskSweep();
  await settle(1, () => operatorEscalations);
  assert.equal(escalationsFor(id, operatorEscalations), 1, 'tick 2 is deduped away');

  // Break the dedup query underneath the guard.
  run(`ALTER TABLE events RENAME TO events_failopen_probe`);
  try {
    await runStaleTaskSweep();
    await settle(2, () => operatorEscalations);
    assert.equal(
      escalationsFor(id, operatorEscalations),
      2,
      'the dedup query threw — the escalation MUST still go through (fail-open), never be swallowed',
    );
  } finally {
    run(`ALTER TABLE events_failopen_probe RENAME TO events`);
  }
});
