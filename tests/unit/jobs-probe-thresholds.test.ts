/**
 * jobs-probe-thresholds.test.ts — U-04a: the jobs probe reports the background
 * jobs themselves and a 180-minute stuck-card threshold.
 *
 * GROUNDING: `probeJobs()` used to call an unknown/silent scheduler healthy and
 * turned a single card 30 minutes old into "Degraded". It now reads the
 * scheduler's own tick ledger (`getWatchedJobLiveness()`), only degrades for a
 * job that is silent past its own window or has failed three times running,
 * treats a boot's warm-up window as a boot and not a stall, and calls a card
 * stuck only past STUCK_IN_PROGRESS_MINUTES (default 180).
 *
 * Run: node --import tsx --test tests/unit/jobs-probe-thresholds.test.ts
 */

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run } from '../../src/lib/db';
import { probeJobs } from '../../src/lib/probes/jobs';

getDb(); // apply full migration chain

const WATCHED = ['intake-advance', 'qc-review-sweep', 'execution-reconcile', 'stuck-in-progress-sweep'];

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function reset(): void {
  run('DELETE FROM tasks');
  run('DELETE FROM job_liveness');
  delete process.env.STUCK_IN_PROGRESS_MINUTES;
}

function seedLiveness(
  jobName: string,
  opts: { ageMinutes?: number; lastStatus?: string; consecutiveFailures?: number } = {},
): void {
  run(
    `INSERT INTO job_liveness (job_name, last_ran_at, last_status, consecutive_failures)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(job_name) DO UPDATE SET
       last_ran_at = excluded.last_ran_at,
       last_status = excluded.last_status,
       consecutive_failures = excluded.consecutive_failures`,
    [
      jobName,
      minutesAgo(opts.ageMinutes ?? 0),
      opts.lastStatus ?? 'ok',
      opts.consecutiveFailures ?? 0,
    ],
  );
}

/** The four watched jobs, all ticking now unless a case says otherwise. */
function seedFreshJobs(): void {
  for (const jobName of WATCHED) seedLiveness(jobName);
}

function seedTask(opts: {
  status: string;
  archivedAt?: string | null;
  updatedAt?: string;
}): string {
  const id = uuidv4();
  // workspace_id explicitly NULL (not the 'default' column default) — this
  // isolated test DB never seeds a 'default' workspace row, and workspace_id
  // carries a REFERENCES workspaces(id) foreign key.
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, business_id, archived_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
    [
      id,
      `probe fixture ${id.slice(0, 8)}`,
      opts.status,
      opts.archivedAt ?? null,
      opts.updatedAt ?? new Date().toISOString(),
    ],
  );
  return id;
}

interface JobsDetail {
  pendingTasks: number;
  workingTasks: number;
  oldestWorkingTask: string | null;
  oldestWorkingTaskUpdatedAt: string | null;
  staleInProgress: number;
  unparseableTimestamps: number;
  warmingUp: boolean;
  watchedJobs: {
    jobName: string;
    stale: boolean;
    failed: boolean;
    disabled: boolean;
    ageMinutes: number | null;
  }[];
}

function detailOf(result: Awaited<ReturnType<typeof probeJobs>>): JobsDetail {
  assert.ok(result.detail, 'probeJobs must return a detail object');
  return result.detail as unknown as JobsDetail;
}

test('all four jobs fresh, no cards → live', async () => {
  reset();
  seedFreshJobs();

  const result = await probeJobs(3600);

  assert.equal(result.status, 'live');
  assert.equal(detailOf(result).staleInProgress, 0);
});

test('one in-progress card 200 minutes old → busy, not degraded', async () => {
  reset();
  seedFreshJobs();
  seedTask({ status: 'in_progress', updatedAt: minutesAgo(200) });

  const result = await probeJobs(3600);

  assert.equal(result.status, 'busy');
  assert.equal(detailOf(result).staleInProgress, 1);
});

test('the same card 60 minutes old → live (under the 180-minute threshold)', async () => {
  reset();
  seedFreshJobs();
  seedTask({ status: 'in_progress', updatedAt: minutesAgo(60) });

  const result = await probeJobs(3600);

  assert.equal(result.status, 'live');
  assert.equal(detailOf(result).staleInProgress, 0);
});

test('STUCK_IN_PROGRESS_MINUTES=30 makes the 60-minute card → busy', async () => {
  reset();
  seedFreshJobs();
  process.env.STUCK_IN_PROGRESS_MINUTES = '30';
  seedTask({ status: 'in_progress', updatedAt: minutesAgo(60) });

  const result = await probeJobs(3600);

  assert.equal(result.status, 'busy');
  assert.equal(detailOf(result).staleInProgress, 1);
});

test('no job_liveness rows at all, one minute of uptime → not degraded, warmingUp true', async () => {
  reset();

  const result = await probeJobs(60);

  assert.notEqual(result.status, 'degraded');
  assert.equal(detailOf(result).warmingUp, true);
});

test('the same empty table, one hour of uptime → degraded', async () => {
  reset();

  const result = await probeJobs(3600);

  assert.equal(result.status, 'degraded');
  assert.equal(detailOf(result).warmingUp, false);
});

test('a job with consecutive_failures = 1 and last_status = error → not degraded', async () => {
  reset();
  seedFreshJobs();
  seedLiveness('qc-review-sweep', { lastStatus: 'error', consecutiveFailures: 1 });

  const result = await probeJobs(3600);

  assert.equal(result.status, 'live');
});

test('a job with consecutive_failures = 3 → degraded', async () => {
  reset();
  seedFreshJobs();
  seedLiveness('qc-review-sweep', { lastStatus: 'error', consecutiveFailures: 3 });

  const result = await probeJobs(3600);

  assert.equal(result.status, 'degraded');
});

test('an archived in-progress card 10 hours old → not counted', async () => {
  reset();
  seedFreshJobs();
  seedTask({
    status: 'in_progress',
    archivedAt: new Date().toISOString(),
    updatedAt: minutesAgo(600),
  });

  const result = await probeJobs(3600);

  assert.equal(detailOf(result).staleInProgress, 0);
  assert.equal(detailOf(result).oldestWorkingTask, null);
  assert.equal(result.status, 'live');
});

test('120 backlog cards → busy', async () => {
  reset();
  seedFreshJobs();
  for (let i = 0; i < 120; i += 1) seedTask({ status: 'backlog' });

  const result = await probeJobs(3600);

  assert.equal(detailOf(result).pendingTasks, 120);
  assert.equal(result.status, 'busy');
});

test('intake-advance 30 minutes old → degraded and the error names it', async () => {
  reset();
  seedFreshJobs();
  seedLiveness('intake-advance', { ageMinutes: 30 });

  const result = await probeJobs(3600);

  assert.equal(result.status, 'degraded');
  assert.match(result.error ?? '', /intake-advance/);
});

test('qc-review-sweep with error status and three failures → degraded', async () => {
  reset();
  seedFreshJobs();
  seedLiveness('qc-review-sweep', { lastStatus: 'error', consecutiveFailures: 3 });

  const result = await probeJobs(3600);

  assert.equal(result.status, 'degraded');
  assert.match(result.error ?? '', /qc-review-sweep/);
});

test('a disabled job with an old timestamp → not degraded', async () => {
  reset();
  seedFreshJobs();
  seedLiveness('execution-reconcile', { ageMinutes: 600, lastStatus: 'disabled' });

  const result = await probeJobs(3600);

  assert.equal(result.status, 'live');
});

test('a card with a full ISO-Z timestamp, 60 minutes old → counted in staleInProgress', async () => {
  reset();
  seedFreshJobs();
  process.env.STUCK_IN_PROGRESS_MINUTES = '30';
  seedTask({ status: 'in_progress', updatedAt: minutesAgo(60) }); // ends in Z

  const result = await probeJobs(3600);

  const detail = detailOf(result);
  assert.equal(detail.unparseableTimestamps, 0);
  assert.equal(detail.staleInProgress, 1);
});
