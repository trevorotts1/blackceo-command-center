/**
 * board-jobs-watchdog.test.ts — C-09 / U40 part 1: "watch the watchers".
 *
 * FAIL-FIRST: against the pre-fix tree, `src/lib/jobs/board-jobs-watchdog.ts`
 * does not exist (NOT-FOUND per the master spec grounding — `probes/jobs.ts`
 * self-describes as the closest proxy for "cron scheduler running" and has no
 * per-job liveness at all), so every test here fails to even import.
 *
 * Coverage (mirrors BINARY acceptance a/b/c in the master spec's C-09 entry):
 *   1. A watched job with NO job_liveness row (never observed) reports stale.
 *   2. A watched job that ticked recently reports NOT stale.
 *   3. A watched job silent beyond 3x its cadence reports stale (the
 *      INTAKE_ADVANCE_SWEEP_ENABLED=0 scenario — deep-health payload shows
 *      the advancer red).
 *   4. checkBoardJobsWatchdog() is side-effect-free (writes nothing) and never
 *      gates — it is a pure read for the deep-health advisory surface.
 *   5. runBoardJobsWatchdog() records exactly ONE cooldown-guarded alert
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
 *   7. DISABLE_BOARD_JOBS_WATCHDOG=1 short-circuits both the check and the
 *      sweep, and never records an alert event.
 *   8. scheduler.ts's recordJobTick() upserts (not duplicates) the
 *      job_liveness row on repeated calls for the same job name.
 *   9. RENAME CONTRACT (this rename): the messages an operator actually reads
 *      are plain English, the pre-rename env var names still work as aliases,
 *      and an alert row written under the OLD event type still suppresses a
 *      duplicate across the upgrade.
 *
 * Run: node --import tsx --test tests/unit/board-jobs-watchdog.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.DISABLE_BOARD_JOBS_WATCHDOG;
delete process.env.BOARD_JOBS_WATCHDOG_ALERT_COOLDOWN_MINUTES;
delete process.env.DISABLE_SWEEP_LIVENESS;
delete process.env.SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-board-jobs-watchdog-workspace-'));

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import {
  getWatchedJobLiveness,
  checkBoardJobsWatchdog,
  runBoardJobsWatchdog,
  STALE_MULTIPLIER,
  WATCHED_JOB_CADENCE_MINUTES,
} from '../../src/lib/jobs/board-jobs-watchdog';
import { recordJobTick } from '../../src/lib/jobs/scheduler';

getDb(); // apply full migration chain (creates job_liveness — migration 102)

/** Every alert type the cooldown query has to see, new names and pre-rename names. */
const ALERT_TYPES = [
  'board_jobs_watchdog_alert',
  'board_jobs_watchdog_alert_unavailable',
  'sweep_liveness_alert',
  'sweep_liveness_alert_unavailable',
];
const ALERT_TYPE_SQL = ALERT_TYPES.map((t) => `'${t}'`).join(',');

function minutesAgoIso(mins: number): string {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

function clearFixtures(): void {
  run(`DELETE FROM job_liveness`);
  run(`DELETE FROM events WHERE type IN (${ALERT_TYPE_SQL})`);
  for (const name of Object.keys(WATCHED_JOB_CADENCE_MINUTES).filter(n=>!['intake-advance','qc-review-sweep'].includes(n))) recordJobTick(name,minutesAgoIso(0),'ok');
}

function alertEventCount(): number {
  return (
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE type IN (${ALERT_TYPE_SQL})`, [])?.n ?? 0
  );
}

function alertEventTypes(): string[] {
  const db = getDb();
  return (db.prepare(`SELECT type FROM events WHERE type IN (${ALERT_TYPE_SQL}) ORDER BY created_at`).all() as { type: string }[]).map((r) => r.type);
}

// ── 1/2/3: getWatchedJobLiveness staleness math ─────────────────────────────

test('board jobs watchdog: watched job with no row is reported stale (never observed is not evidence of health)', () => {
  clearFixtures();
  run('DELETE FROM job_liveness');
  const rows = getWatchedJobLiveness();
  assert.equal(rows.length, Object.keys(WATCHED_JOB_CADENCE_MINUTES).length);
  for (const r of rows) {
    assert.equal(r.stale, true);
    assert.equal(r.lastRanAt, null);
  }
});

test('board jobs watchdog: watched job that ticked recently is NOT stale', () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(0.5), 'ok');
  recordJobTick('qc-review-sweep', minutesAgoIso(0.5), 'ok');

  const rows = getWatchedJobLiveness();
  for (const r of rows) {
    assert.equal(r.stale, false, `${r.jobName} should not be stale`);
  }
});

test('board jobs watchdog: watched job silent beyond 3x its cadence is stale', () => {
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

// ── 4: checkBoardJobsWatchdog is a pure, non-gating read ────────────────────

test('checkBoardJobsWatchdog: pure read — writes nothing, pass=false when a watched job is stale (advisory, non-gating)', () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(60), 'ok'); // way stale
  recordJobTick('qc-review-sweep', minutesAgoIso(0.5), 'ok');

  const result = checkBoardJobsWatchdog();
  assert.equal(result.pass, false);
  assert.match(result.detail, /intake-advance/);
  assert.equal(alertEventCount(), 0, 'checkBoardJobsWatchdog must be side-effect-free (no alert record)');
});

test('checkBoardJobsWatchdog: pass=true when all watched jobs are healthy', () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(0.2), 'ok');
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'ok');

  const result = checkBoardJobsWatchdog();
  assert.equal(result.pass, true);
});

// ── 5: runBoardJobsWatchdog — exactly one alert, cooldown-guarded ───────────

test('runBoardJobsWatchdog: records exactly one alert for a stale watched job, then cooldown-suppresses a second run', async () => {
  clearFixtures();
  process.env.BOARD_JOBS_WATCHDOG_ALERT_COOLDOWN_MINUTES = '60';
  recordJobTick('intake-advance', minutesAgoIso(60), 'ok'); // stale (INTAKE_ADVANCE_SWEEP_ENABLED=0 scenario)
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'ok');

  try {
    const first = await runBoardJobsWatchdog();
    assert.equal(first.alerted, false, 'unconfigured notifier must not claim delivery');
    assert.equal(first.notificationStatus, 'unavailable');
    assert.deepEqual(first.staleJobs, ['intake-advance']);
    assert.equal(alertEventCount(), 1, 'exactly one operator alert recorded');
    assert.deepEqual(alertEventTypes(), ['board_jobs_watchdog_alert_unavailable'], 'the alert is written under the NEW event type');

    const second = await runBoardJobsWatchdog();
    assert.equal(second.alerted, false, 'cooldown must suppress a second alert for the same condition');
    assert.deepEqual(second.staleJobs, ['intake-advance'], 'the condition is still reported even while cooldown-suppressed');
    assert.equal(alertEventCount(), 1, 'still exactly one alert recorded after the cooldown-guarded re-run');
  } finally {
    delete process.env.BOARD_JOBS_WATCHDOG_ALERT_COOLDOWN_MINUTES;
  }
});

test('runBoardJobsWatchdog: no alert when every watched job is healthy', async () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(0.2), 'ok');
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'ok');

  const result = await runBoardJobsWatchdog();
  assert.equal(result.alerted, false);
  assert.deepEqual(result.staleJobs, []);
  assert.equal(alertEventCount(), 0);
});

// ── 6: re-ticking clears the red state immediately (live-computed, no cache) ─

test('board jobs watchdog: re-enabling (a fresh tick) clears the stale state on the very next read', () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(60), 'ok');
  assert.equal(checkBoardJobsWatchdog().pass, false);

  // Simulate the advancer resuming (INTAKE_ADVANCE_SWEEP_ENABLED re-enabled,
  // its next 2-minute tick lands).
  recordJobTick('intake-advance', minutesAgoIso(0), 'ok');
  recordJobTick('qc-review-sweep', minutesAgoIso(0), 'ok');

  assert.equal(checkBoardJobsWatchdog().pass, true, 'the very next tick must clear the red state — no stale caching');
});

// ── 6b: intentionally disabled sweeps are not faults ────────────────────────

test('checkBoardJobsWatchdog: a sweep ticking with status disabled (kill flag set) passes and is named in the OK detail', async () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(0.2), 'disabled', 'INTAKE_ADVANCE_SWEEP_ENABLED=0');
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'disabled', 'DISABLE_QC_REVIEW_SWEEP env is set');

  const check = checkBoardJobsWatchdog();
  assert.equal(check.pass, true);
  assert.equal(
    check.detail,
    'board_jobs_watchdog: all 4 background jobs are running on schedule. intake-advance and qc-review-sweep are switched off on this box.',
  );

  const sweep = await runBoardJobsWatchdog();
  assert.equal(sweep.alerted, false);
  assert.deepEqual(sweep.disabledJobs, ['intake-advance', 'qc-review-sweep']);
  assert.equal(alertEventCount(), 0);
});

test('checkBoardJobsWatchdog: a disabled sweep that stops ticking is still reported silent (scheduler death is not masked)', async () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(0.2), 'disabled');
  recordJobTick('qc-review-sweep', minutesAgoIso(30), 'disabled'); // 3x cadence is 6 min

  const check = checkBoardJobsWatchdog();
  assert.equal(check.pass, false);
  assert.match(check.detail, /qc-review-sweep has not run for 30 minutes/);
  assert.doesNotMatch(check.detail, /intake-advance/);

  const sweep = await runBoardJobsWatchdog();
  assert.deepEqual(sweep.staleJobs, ['qc-review-sweep']);
  assert.ok(sweep.notificationStatus === 'queued' || sweep.notificationStatus === 'unavailable'); // an alert event is written either way
  assert.equal(alertEventCount(), 1);
});

// ── 7: DISABLE_BOARD_JOBS_WATCHDOG kill switch ──────────────────────────────

test('DISABLE_BOARD_JOBS_WATCHDOG=1: check reports indeterminate (monitor switched off) and the sweep never alerts', async () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(120), 'ok'); // would otherwise be stale

  process.env.DISABLE_BOARD_JOBS_WATCHDOG = '1';
  try {
    const check = checkBoardJobsWatchdog();
    assert.equal(check.pass, false);
    assert.equal(check.indeterminate, true);
    assert.equal(
      check.detail,
      'board_jobs_watchdog: board jobs watchdog is switched off on this box (DISABLE_BOARD_JOBS_WATCHDOG).',
    );

    const sweep = await runBoardJobsWatchdog();
    assert.equal(sweep.skippedReason, 'DISABLE_BOARD_JOBS_WATCHDOG set');
    assert.equal(sweep.alerted, false);
    assert.equal(alertEventCount(), 0);
  } finally {
    delete process.env.DISABLE_BOARD_JOBS_WATCHDOG;
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

// ── 9: the rename contract — plain English, env aliases, event-type bridge ───
//
// The owner's requirement for this rename was: "it needs to be named according
// to what it does, so when I or somebody else sees it, they know what it is."
// These tests pin the operator-facing text itself, not just the code names, so
// a future refactor cannot quietly put the jargon back.

test('plain English: a silent job says how long it has been silent, what should have happened, and what to check', () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(17), 'ok');
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'ok');

  const detail = checkBoardJobsWatchdog().detail;
  assert.equal(
    detail,
    'board_jobs_watchdog: intake-advance has not run for 17 minutes (it should run every 2 minutes). ' +
      'The background loop that moves tasks may have stopped. Check the command center process.',
  );
  // The jargon this rename exists to remove must not come back.
  assert.doesNotMatch(detail, /tick|liveness|stale|sweep_liveness/i);
});

test('plain English: a job that has never run says so, rather than reporting a nonsense age', () => {
  clearFixtures();
  run('DELETE FROM job_liveness');

  const detail = checkBoardJobsWatchdog().detail;
  assert.match(detail, /^board_jobs_watchdog: /);
  for (const job of Object.keys(WATCHED_JOB_CADENCE_MINUTES)) {
    assert.ok(
      detail.includes(`${job} has never run since the command center started.`),
      `${job} should be reported as never having run — detail was: ${detail}`,
    );
  }
  // Several problems are joined with a pipe so one Telegram line stays readable.
  assert.equal(detail.split(' | ').length, Object.keys(WATCHED_JOB_CADENCE_MINUTES).length);
});

test('plain English: a failing job names the consecutive failure count and the error code', () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(0.2), 'ok');
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'error', 'scheduler_job_timeout');
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'error', 'scheduler_job_timeout');

  const detail = checkBoardJobsWatchdog().detail;
  assert.equal(
    detail,
    'board_jobs_watchdog: qc-review-sweep has failed 2 runs in a row (last error: scheduler_job_timeout). ' +
      'Check the command center logs.',
  );
});

test('plain English: the healthy message counts the jobs, and one switched-off job reads as singular', () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(0.2), 'ok');
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'ok');
  assert.equal(
    checkBoardJobsWatchdog().detail,
    'board_jobs_watchdog: all 4 background jobs are running on schedule.',
  );

  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'disabled');
  assert.equal(
    checkBoardJobsWatchdog().detail,
    'board_jobs_watchdog: all 4 background jobs are running on schedule. qc-review-sweep is switched off on this box.',
  );
});

test('deprecated env alias: DISABLE_SWEEP_LIVENESS still switches the watchdog off on a box that has not been re-keyed', async () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(120), 'ok'); // would otherwise be stale

  process.env.DISABLE_SWEEP_LIVENESS = '1';
  try {
    assert.equal(checkBoardJobsWatchdog().indeterminate, true, 'the pre-rename kill flag must keep working');
    const sweep = await runBoardJobsWatchdog();
    assert.equal(sweep.skippedReason, 'DISABLE_BOARD_JOBS_WATCHDOG set');
    assert.equal(alertEventCount(), 0);
  } finally {
    delete process.env.DISABLE_SWEEP_LIVENESS;
  }

  // CONTROL: with the alias removed the very same fixture is NOT disabled, so
  // the assertion above is a fact about the alias, not about the fixture.
  assert.equal(checkBoardJobsWatchdog().indeterminate, undefined);
  assert.equal(checkBoardJobsWatchdog().pass, false);
});

test('deprecated env alias: the new name wins over the old one when both are set', async () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(120), 'ok');

  process.env.DISABLE_SWEEP_LIVENESS = '1';
  process.env.DISABLE_BOARD_JOBS_WATCHDOG = '0';
  try {
    const check = checkBoardJobsWatchdog();
    assert.equal(check.indeterminate, undefined, 'the NEW name must win, so the watchdog stays on');
    assert.equal(check.pass, false, 'and it still reports the stale job');
  } finally {
    delete process.env.DISABLE_SWEEP_LIVENESS;
    delete process.env.DISABLE_BOARD_JOBS_WATCHDOG;
  }
});

test('deprecated env alias: SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES still controls the cooldown window', async () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(120), 'ok'); // stale
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'ok');
  // An alert already recorded 30 minutes ago, under the OLD event type name —
  // exactly what a live box carries across this upgrade.
  run('INSERT INTO events(id,type,task_id,message,created_at) VALUES(?,?,NULL,?,?)', [
    uuidv4(), 'sweep_liveness_alert', 'pre-rename alert row', minutesAgoIso(30),
  ]);

  process.env.SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES = '60';
  try {
    const suppressed = await runBoardJobsWatchdog();
    assert.equal(suppressed.notificationStatus, 'cooldown', 'a 60m window must still be suppressing at 30m');
    assert.equal(alertEventCount(), 1, 'no second alert row written');
  } finally {
    delete process.env.SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES;
  }

  // CONTROL: shrink the window below the age of that row and the same call
  // alerts, proving the suppression above came from the cooldown value and the
  // old-type row, not from some unrelated short-circuit.
  process.env.SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES = '10';
  try {
    const fired = await runBoardJobsWatchdog();
    assert.notEqual(fired.notificationStatus, 'cooldown');
    assert.equal(alertEventCount(), 2);
  } finally {
    delete process.env.SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES;
  }
});

test('upgrade bridge: a pre-rename alert row suppresses a duplicate under the default cooldown', async () => {
  clearFixtures();
  recordJobTick('intake-advance', minutesAgoIso(120), 'ok'); // stale
  recordJobTick('qc-review-sweep', minutesAgoIso(0.2), 'ok');
  run('INSERT INTO events(id,type,task_id,message,created_at) VALUES(?,?,NULL,?,?)', [
    uuidv4(), 'sweep_liveness_alert_unavailable', 'pre-rename alert row', minutesAgoIso(1),
  ]);

  const result = await runBoardJobsWatchdog();
  assert.equal(result.notificationStatus, 'cooldown', 'the upgrade must not re-page for a condition already alerted');
  assert.equal(alertEventCount(), 1);
});
