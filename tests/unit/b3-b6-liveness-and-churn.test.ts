/**
 * b3-b6-liveness-and-churn.test.ts — stuck-sweep liveness (B3) + review-churn /
 * cap-out (B6).
 *
 * B3: probeSessionLiveness() classifies a session as alive / idle / unknown from
 *     an injected chat.history reader (no live gateway needed) — the caller skips
 *     the force-block ONLY on 'alive'. Also asserts the higher default threshold.
 * B6: the intake-advance sweep surfaces a QC-reroute-capped task to the operator
 *     EXACTLY once (task_capped event dedup); the stale sweep does NOT bounce a
 *     review task deliberately parked by QC (heuristic / provider-down markers).
 *
 *   node --import tsx --test tests/unit/b3-b6-liveness-and-churn.test.ts
 */

// Keep every notify path silent + local (no Telegram / webhook shell-out).
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_NOTIFY_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.DISABLE_STALE_TASK_SWEEP;
delete process.env.INTAKE_ADVANCE_SWEEP_ENABLED;

import './_isolated-db'; // MUST be first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne, queryAll } from '../../src/lib/db';
import { probeSessionLiveness, type SessionHistoryReader } from '../../src/lib/jobs/execution-watcher';
import { runStaleTaskSweep } from '../../src/lib/jobs/stale-task-sweep';
import { runIntakeAdvanceSweep } from '../../src/lib/jobs/intake-advance-sweep';

const db = getDb();
const WS_ID = `ws-${uuidv4()}`;
run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 900)', [WS_ID, 'B3B6 WS', `b3b6-${uuidv4().slice(0, 8)}`]);

function hoursAgoIso(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

const baseTask = {
  id: 't',
  assigned_agent_id: 'a',
  assigned_agent_name: 'Engineering',
  assigned_agent_role: 'Head',
  workspace_id: WS_ID,
  openclaw_session_id: 'mission-control-engineering',
};

// ── B3: liveness probe ───────────────────────────────────────────────────────

test('B3: probe → alive when a session message is newer than the cutoff', async () => {
  const cutoffMs = Date.now() - 60 * 60_000; // 60 min ago
  const reader: SessionHistoryReader = async () => [
    { role: 'assistant', ts: Date.now() - 2 * 60_000 }, // 2 min ago → newer than cutoff
  ];
  assert.equal(await probeSessionLiveness(baseTask, cutoffMs, reader), 'alive');
});

test('B3: probe → alive with an ISO-string timestamp too', async () => {
  const cutoffMs = Date.now() - 60 * 60_000;
  const reader: SessionHistoryReader = async () => [
    { role: 'assistant', created_at: new Date(Date.now() - 3 * 60_000).toISOString() },
  ];
  assert.equal(await probeSessionLiveness(baseTask, cutoffMs, reader), 'alive');
});

test('B3: probe → idle when the session responds but all messages predate the cutoff', async () => {
  const cutoffMs = Date.now() - 60 * 60_000;
  const reader: SessionHistoryReader = async () => [
    { role: 'assistant', ts: Date.now() - 120 * 60_000 }, // 2h ago → older than cutoff
  ];
  assert.equal(await probeSessionLiveness(baseTask, cutoffMs, reader), 'idle');
});

test('B3: probe never falsely reports alive — empty → unknown, untimed → idle', async () => {
  const cutoffMs = Date.now() - 60 * 60_000;
  assert.equal(await probeSessionLiveness(baseTask, cutoffMs, async () => []), 'unknown');
  // A response with messages but no usable timestamp is idle (NEVER 'alive'), so
  // the caller falls through to the block path — the safety net is preserved.
  assert.equal(
    await probeSessionLiveness(baseTask, cutoffMs, async () => [{ role: 'assistant' }]),
    'idle',
    'a response with no timestamp is idle, not alive',
  );
});

test('B3: probe → unknown when no session id can be derived', async () => {
  const t = { ...baseTask, openclaw_session_id: null, assigned_agent_name: null };
  assert.equal(await probeSessionLiveness(t, Date.now(), async () => [{ ts: Date.now() }]), 'unknown');
});

// ── B6: stale sweep must NOT churn a QC-parked review task ────────────────────

test('B6: stale sweep spares a review task parked by QC, still returns a plain stale one', async () => {
  const mkReview = (): string => {
    const id = uuidv4();
    run(
      `INSERT INTO tasks (id, title, status, workspace_id, updated_at, last_progress_at)
       VALUES (?, ?, 'review', ?, ?, ?)`,
      [id, 'B6 review', WS_ID, hoursAgoIso(20), hoursAgoIso(20)], // 20h > 12h review threshold
    );
    return id;
  };
  const parked = mkReview();
  run(
    `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'qc_review', ?, ?, ?)`,
    [uuidv4(), parked, '[QC-HEURISTIC] Score 7.5/10 — human review required', hoursAgoIso(19)],
  );
  const deferred = mkReview();
  run(
    `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'qc_review', ?, ?, ?)`,
    [uuidv4(), deferred, '[QC-DEFERRED-PROVIDER-DOWN] provider blip', hoursAgoIso(19)],
  );
  const plain = mkReview(); // stale, no QC-park marker

  await runStaleTaskSweep();

  const statusOf = (id: string) => queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
  assert.equal(statusOf(parked), 'review', 'heuristic-parked review task NOT churned to backlog');
  assert.equal(statusOf(deferred), 'review', 'provider-down-deferred review task NOT churned to backlog');
  assert.equal(statusOf(plain), 'backlog', 'a genuinely stale review task IS still returned');
});

// ── B6: intake-advance cap-out surfaced once ─────────────────────────────────

test('B6: a QC-reroute-capped task is surfaced to the operator exactly once', async () => {
  const cap = parseInt(process.env.QC_MAX_REROUTES || '3', 10);
  const id = uuidv4();
  // Capped task sits in backlog (filtered out of the advance selection) and would
  // otherwise rot invisibly. qc_reroute_attempts >= cap; recent updated_at so the
  // stale sweep is irrelevant here.
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, qc_reroute_attempts, updated_at, last_progress_at)
     VALUES (?, ?, 'backlog', ?, ?, ?, ?)`,
    [id, 'B6 capped', WS_ID, cap, new Date().toISOString(), new Date().toISOString()],
  );

  await runIntakeAdvanceSweep();
  let events = queryAll<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task_capped'`,
    [id],
  );
  assert.equal(events[0].n, 1, 'exactly one task_capped event after the first sweep');

  // Second sweep: the NOT EXISTS dedup guard keeps it at one (fires once).
  await runIntakeAdvanceSweep();
  events = queryAll<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task_capped'`,
    [id],
  );
  assert.equal(events[0].n, 1, 'still exactly one task_capped event after a second sweep (no duplicate alert)');
});
