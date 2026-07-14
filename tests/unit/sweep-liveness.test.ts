/**
 * sweep-liveness.test.ts — C-09 / U40 part 1: "watch the watchers".
 *
 * FAIL-FIRST: against the pre-fix tree, `src/lib/jobs/sweep-liveness.ts` does
 * not exist (NOT-FOUND per the master spec grounding — `probes/jobs.ts`
 * self-describes as the closest proxy for "cron scheduler running" and has no
 * per-job liveness at all), so every test here fails to even import.
 *
 * Coverage (mirrors BINARY acceptance a/b/c in the master spec's C-09 entry):
 *   1. A watched job with NO job_liveness row (never observed) reports stale.
 *   2. A watched job that ticked recently reports NOT stale.
 *   3. A watched job silent beyond 3x its cadence reports stale (the
 *      INTAKE_ADVANCE_SWEEP_ENABLED=0 scenario — deep-health payload shows
 *      the advancer red).
 *   4. checkSweepLiveness() is side-effect-free (writes nothing) and never
 *      gates — it is a pure read for the deep-health advisory surface.
 *   5. runSweepLivenessSweep() records exactly ONE cooldown-guarded alert
 *      event for a stale watched job; a second run within the cooldown
 *      window does NOT record a second one (same dedup pattern
 *      board-hygiene's blend-regression check established for a board-wide,
 *      non-task-scoped condition: an `events` row with task_id NULL).
 *      notifySystem() itself is exercised for real (never mocked) with the
 *      same network-free suppression board-hygiene.test.ts already uses
 *      (OWNER_NOTIFY_TELEGRAM_DISABLED=1, no webhook, no resolvable operator
 *      chat id -> falls through to the durable undeliverable record, which
 *      writes into the throwaway OPENCLAW_WORKSPACE_PATH this file sets up).
 *   6. Re-ticking the job (simulating "re-enabling") makes the very next read
 *      report healthy again — no caching, live-computed.
 *   7. DISABLE_SWEEP_LIVENESS=1 short-circuits both the check and the sweep,
 *      and never records an alert event.
 *   8. scheduler.ts's recordJobTick() upserts (not duplicates) the
 *      job_liveness row on repeated calls for the same job name.
 *
 * Run: node --import tsx --test tests/unit/sweep-liveness.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.DISABLE_SWEEP_LIVENESS;
delete process.env.SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-sweep-liveness-workspace-'));

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, run, queryOne } from '../../src/lib/db';
import {
  getWatchedJobLiveness,
  checkSweepLiveness,
  runSweepLivenessSweep,
  STALE_MULTIPLIER,
  WATCHED_JOB_CADENCE_MINUTES,
} from '../../src/lib/jobs/sweep-liveness';
import { recordJobTick } from '../../src/lib/jobs/scheduler';

getDb(); // apply full migration chain (creates job_liveness — migration 102)

function minutesAgoIso(mins: number): string {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

function clearFixtures(): void {
  run(`DELETE FROM job_liveness`);
  run(`DELETE FROM events WHERE type = 'sweep_liveness_alert'`);
}

function alertEventCount(): number {
  return (
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE type = 'sweep_liveness_alert'`, [])?.n ?? 0
  );
}

// ── 1/2/3: getWatchedJobLiveness staleness math ─────────────────────────────

test('sweep-liveness: watched job with no row is reported stale (never observed is not evidence of health)', () => {
  clearFixtures();
  const rows = getWatchedJobLiveness();
  assert.equal(rows.length, Object.keys(WATCHED_JOB_CADENCE_MINUTES).length);
  for (const r of rows) {
    assert.equal(r.stale, true);
    assert.equal(r.lastRanAt, null);
  }
});

test('sweep-liveness: watched job that ticked recently is NOT stale', () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(0.5), 'ok');
  recordJobTick('qc-review-sweep', minutesAgoIso(0.5), 'ok');

  const rows = getWatchedJobLiveness();
  for (const r of rows) {
    assert.equal(r.stale, false, `${r.jobName} should not be stale`);
  }
});

test('sweep-liveness: watched job silent beyond 3x its cadence is stale', () => {
  clearFixtures();
  const cadence = WATCHED_JOB_CADENCE_MINUTES['intake-advance'];
  // Just past the threshold.
  recordJobTick('intake-advance', minutesAgoIso(cadence * STALE_MULTIPLIER + 1), 'ok');
  recordJobTick('qc-review-sweep', minutesAgoIso(0.5), 'ok'); // healthy control

  const rows = getWatchedJobLiveness();
  const advancer = rows.find((r) => r.jobName === 'intake-advance');
  const qc = rows.find((r) => r.jobName === 'qc-review-sweep');
  assert.equal(advancer?.stale, true);
  assert.equal(qc?.stale, false);
});

// ── 4: checkSweepLiveness is a pure, non-gating read ────────────────────────

test('checkSweepLiveness: pure read — writes nothing, pass=false when a watched job is stale (advisory, non-gating)', () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(60), 'ok'); // way stale
  recordJobTick('qc-review-sweep', minutesAgoIso(0.5), 'ok');

  const result = checkSweepLiveness();
  assert.equal(result.pass, false);
  assert.match(result.detail, /intake-advance/);
  assert.equal(alertEventCount(), 0, 'checkSweepLiveness must be side-effect-free (no alert record)');
});

test('checkSweepLiveness: pass=true when all watched jobs are healthy', () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(0.2), 'ok');
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'ok');

  const result = checkSweepLiveness();
  assert.equal(result.pass, true);
});

// ── 5: runSweepLivenessSweep — exactly one alert, cooldown-guarded ──────────

test('runSweepLivenessSweep: records exactly one alert for a stale watched job, then cooldown-suppresses a second run', async () => {
  clearFixtures();
  process.env.SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES = '60';
  recordJobTick('intake-advance', minutesAgoIso(60), 'ok'); // stale (INTAKE_ADVANCE_SWEEP_ENABLED=0 scenario)
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'ok');

  try {
    const first = await runSweepLivenessSweep();
    assert.equal(first.alerted, true);
    assert.deepEqual(first.staleJobs, ['intake-advance']);
    assert.equal(alertEventCount(), 1, 'exactly one operator alert recorded');

    const second = await runSweepLivenessSweep();
    assert.equal(second.alerted, false, 'cooldown must suppress a second alert for the same condition');
    assert.deepEqual(second.staleJobs, ['intake-advance'], 'the condition is still reported even while cooldown-suppressed');
    assert.equal(alertEventCount(), 1, 'still exactly one alert recorded after the cooldown-guarded re-run');
  } finally {
    delete process.env.SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES;
  }
});

test('runSweepLivenessSweep: no alert when every watched job is healthy', async () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(0.2), 'ok');
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'ok');

  const result = await runSweepLivenessSweep();
  assert.equal(result.alerted, false);
  assert.deepEqual(result.staleJobs, []);
  assert.equal(alertEventCount(), 0);
});

// ── 6: re-ticking clears the red state immediately (live-computed, no cache) ─

test('sweep-liveness: re-enabling (a fresh tick) clears the stale state on the very next read', () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(60), 'ok');
  assert.equal(checkSweepLiveness().pass, false);

  // Simulate the advancer resuming (INTAKE_ADVANCE_SWEEP_ENABLED re-enabled,
  // its next 2-minute tick lands).
  recordJobTick('intake-advance', minutesAgoIso(0), 'ok');
  recordJobTick('qc-review-sweep', minutesAgoIso(0), 'ok');

  assert.equal(checkSweepLiveness().pass, true, 'the very next tick must clear the red state — no stale caching');
});

// ── 7: DISABLE_SWEEP_LIVENESS kill switch ───────────────────────────────────

test('DISABLE_SWEEP_LIVENESS=1: check reports pass (disabled, never a false red) and the sweep never alerts', async () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(120), 'ok'); // would otherwise be stale

  process.env.DISABLE_SWEEP_LIVENESS = '1';
  try {
    const check = checkSweepLiveness();
    assert.equal(check.pass, true);
    assert.match(check.detail, /disabled/i);

    const sweep = await runSweepLivenessSweep();
    assert.equal(sweep.skippedReason, 'DISABLE_SWEEP_LIVENESS set');
    assert.equal(sweep.alerted, false);
    assert.equal(alertEventCount(), 0);
  } finally {
    delete process.env.DISABLE_SWEEP_LIVENESS;
  }
});

// ── 8: recordJobTick upserts, never duplicates ──────────────────────────────

test('recordJobTick: upserts the job_liveness row for the same job name (no duplicate rows)', () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(10), 'ok');
  recordJobTick('intake-advance', minutesAgoIso(1), 'error', 'boom');

  const rows = getWatchedJobLiveness();
  const advancer = rows.find((r) => r.jobName === 'intake-advance');
  assert.equal(advancer?.lastStatus, 'error');
  assert.ok(advancer && advancer.ageMinutes !== null && advancer.ageMinutes < 2);

  // Assert there is exactly one row for this job name at the storage layer.
  const db = getDb();
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM job_liveness WHERE job_name = ?`)
    .get('intake-advance') as { n: number };
  assert.equal(count.n, 1);
});
