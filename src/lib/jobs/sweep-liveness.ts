/**
 * Sweep liveness — "watch the watchers" (C-09 / U40).
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * The root-caused stuck-card pattern (the master spec's "Maria" incident) is
 * a silent path: `autoDispatchTask`'s agent-not-found branch `console.warn`s
 * and returns — no event, no backoff, no alert — while the single advancer
 * re-selects the same card every 2 minutes forever (task-dispatcher.ts). That
 * is bad enough on its own; what makes it invisible is that NOTHING watches
 * the watcher — if the advancer sweep itself stops ticking (crashed process,
 * an unhandled throw outside `wrap()`, a hung DB lock, `INTAKE_ADVANCE_SWEEP_
 * ENABLED=0` left set after a debugging session), the board simply goes quiet
 * and nobody is told. `probes/jobs.ts` self-describes as "the closest current
 * proxy for 'cron scheduler running'" and has no per-job liveness signal at
 * all — this module is that missing signal.
 *
 * ── How it works ─────────────────────────────────────────────────────────
 * `scheduler.ts`'s `wrap()` upserts one row per job name into `job_liveness`
 * on EVERY tick — success or failure, because a tick is a liveness signal,
 * not a success signal (a job that throws every time is still ticking, which
 * is a different, already-logged problem; a job that stops ticking at all is
 * the silent one this closes).
 *
 * Two consumers read that same table through the ONE function below
 * (`getWatchedJobLiveness`) so the "is it stale" answer can never diverge:
 *   1. `checkSweepLiveness()` — a pure, side-effect-free read used by the
 *      deep-health surface (`/api/health/deep`, `advisory.sweep_liveness`).
 *      Reported ADVISORY / non-gating, same posture as the board-projection
 *      drift banner (A7): the box stays green overall even while this chip
 *      goes red, because a stalled advancer is an operational signal, not a
 *      Command Center correctness fault.
 *   2. `runSweepLivenessSweep()` — the scheduler.ts-registered cron entry
 *      point (every 2 minutes, matching the watched jobs' own cadence). When
 *      a watched job is stale it fires ONE cooldown-guarded `notifySystem()`
 *      alert (SYSTEM audience only — MOVE-IN-SILENCE; this never reaches a
 *      client). Cooldown state rides the `events` table with a NULL task_id
 *      (board-hygiene's `processBlendRegressionCheck` established this exact
 *      pattern for a board-wide, non-task-scoped condition).
 *
 * Watched set: the two advancers named in the spec — `intake-advance` (THE
 * single board-advancement authority) and `qc-review-sweep`. Both tick every
 * 2 minutes; "stale" means no tick recorded for STALE_MULTIPLIER (3) times
 * that cadence, i.e. 6 minutes of silence. The other ~15 lower-stakes jobs in
 * scheduler.ts's JOBS registry (daily/weekly maintenance, usage refresh,
 * etc.) still get their tick persisted to `job_liveness` by the same `wrap()`
 * change, so extending the watched set later is a one-line addition — but
 * alerting on every one of them today would violate the same anti-spam
 * discipline board-hygiene already applies (cooldown-guarded, batched, never
 * a per-job drip).
 *
 * Tuning / opt-out:
 *   • SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES — re-alert cadence while the
 *     condition persists (default 60).
 *   • DISABLE_SWEEP_LIVENESS=1 — turn the whole watchdog off (cron sweep
 *     no-ops; the deep-health chip reports disabled/pass, never a false red).
 */

import { queryOne, run, timeNow, sqlTime, parseDbTime } from '@/lib/db';
import { notifySystem } from '@/lib/notify';
import { v4 as uuidv4 } from 'uuid';

/** A tick recorded more than this many multiples of a job's own cadence ago
 *  counts as stale. */
export const STALE_MULTIPLIER = 3;

/** The two advancers this watchdog actively alerts on (see file header). */
export const WATCHED_JOB_CADENCE_MINUTES: Record<string, number> = {
  'intake-advance': 2,
  'qc-review-sweep': 2,
};

const EVT_SWEEP_LIVENESS_ALERT = 'sweep_liveness_alert';

function numEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const ALERT_COOLDOWN_MINUTES = numEnv('SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES', 60);

function isDisabled(): boolean {
  return (
    process.env.DISABLE_SWEEP_LIVENESS === '1' ||
    process.env.DISABLE_SWEEP_LIVENESS === 'true'
  );
}

export interface WatchedJobLiveness {
  jobName: string;
  cadenceMinutes: number;
  lastRanAt: string | null;
  lastStatus: string | null;
  ageMinutes: number | null;
  staleThresholdMinutes: number;
  stale: boolean;
}

/**
 * Single source of truth: read `job_liveness` for every watched job and
 * compute staleness against STALE_MULTIPLIER x its cadence. A job with NO row
 * yet (never ticked since this table existed — e.g. right after migration on
 * a box that has not reached the job's first cron fire) is reported stale:
 * "never observed" is not evidence of health.
 */
export function getWatchedJobLiveness(): WatchedJobLiveness[] {
  return Object.entries(WATCHED_JOB_CADENCE_MINUTES).map(([jobName, cadenceMinutes]) => {
    const staleThresholdMinutes = cadenceMinutes * STALE_MULTIPLIER;
    let row: { last_ran_at: string; last_status: string } | undefined;
    try {
      row = queryOne<{ last_ran_at: string; last_status: string }>(
        `SELECT last_ran_at, last_status FROM job_liveness WHERE job_name = ?`,
        [jobName],
      );
    } catch {
      row = undefined; // table absent (pre-102 box) or unreadable -- treat as never-observed
    }

    if (!row) {
      return {
        jobName,
        cadenceMinutes,
        lastRanAt: null,
        lastStatus: null,
        ageMinutes: null,
        staleThresholdMinutes,
        stale: true,
      };
    }

    const ageMs = Date.now() - parseDbTime(row.last_ran_at);
    const ageMinutes = Number.isFinite(ageMs) ? ageMs / 60000 : Infinity;

    return {
      jobName,
      cadenceMinutes,
      lastRanAt: row.last_ran_at,
      lastStatus: row.last_status,
      ageMinutes: Number.isFinite(ageMinutes) ? ageMinutes : null,
      staleThresholdMinutes,
      stale: !Number.isFinite(ageMinutes) || ageMinutes > staleThresholdMinutes,
    };
  });
}

export interface SweepLivenessCheckResult {
  pass: boolean;
  detail: string;
  indeterminate?: boolean;
  watched: WatchedJobLiveness[];
}

/**
 * Pure, side-effect-free read for the deep-health advisory surface. NEVER
 * gates the top-level pass/indeterminate verdict — the caller (the deep
 * health route) must place this under `advisory`, mirroring
 * `checkAnthologyBoardProjection`'s posture exactly (A7).
 */
export function checkSweepLiveness(): SweepLivenessCheckResult {
  if (isDisabled()) {
    return {
      pass: true,
      detail: 'sweep_liveness: disabled on this box (DISABLE_SWEEP_LIVENESS=1)',
      watched: [],
    };
  }

  const watched = getWatchedJobLiveness();
  const stale = watched.filter((w) => w.stale);

  if (stale.length === 0) {
    return {
      pass: true,
      detail: `sweep_liveness: OK — ${watched.map((w) => w.jobName).join(', ')} ticking within threshold`,
      watched,
    };
  }

  return {
    pass: false,
    detail:
      `sweep_liveness: DRIFT — ${stale
        .map((w) => `${w.jobName} silent for ${w.ageMinutes === null ? 'ever (never observed)' : `${Math.round(w.ageMinutes)}m`} (threshold ${w.staleThresholdMinutes}m)`)
        .join('; ')}`,
    watched,
  };
}

export interface SweepLivenessSweepResult {
  ranAt: string;
  skippedReason?: string;
  staleJobs: string[];
  alerted: boolean;
}

/**
 * scheduler.ts-registered cron entry point. Cooldown-guarded (ALERT_COOLDOWN_
 * MINUTES, default 60): at most one notifySystem() per cooldown window while
 * the condition persists, so a multi-hour outage does not spam every 2-minute
 * tick. `re-enabling clears it within one cadence` (BINARY acceptance b) falls
 * out for free — the very next intake-advance tick upserts a fresh
 * `job_liveness` row, and this function (and checkSweepLiveness) recompute
 * live on every call, no caching.
 */
export async function runSweepLivenessSweep(): Promise<SweepLivenessSweepResult> {
  const ranAt = timeNow();

  if (isDisabled()) {
    return { ranAt, skippedReason: 'DISABLE_SWEEP_LIVENESS set', staleJobs: [], alerted: false };
  }

  const watched = getWatchedJobLiveness();
  const stale = watched.filter((w) => w.stale);

  if (stale.length === 0) {
    return { ranAt, staleJobs: [], alerted: false };
  }

  const staleJobNames = stale.map((w) => w.jobName);

  let recentAlert = 0;
  try {
    recentAlert =
      queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM events
          WHERE type = ? AND ${sqlTime('created_at')} >= datetime('now', ?)`,
        [EVT_SWEEP_LIVENESS_ALERT, `-${ALERT_COOLDOWN_MINUTES} minutes`],
      )?.n ?? 0;
  } catch {
    recentAlert = 0;
  }

  if (recentAlert > 0) {
    // Already alerted within the cooldown window -- stay quiet, still report
    // the stale set so the caller's log line is honest about the ongoing drift.
    return { ranAt, staleJobs: staleJobNames, alerted: false };
  }

  const message =
    `[SWEEP-LIVENESS] watchdog: ${stale
      .map((w) => `${w.jobName} silent for ${w.ageMinutes === null ? 'ever (never observed)' : `${Math.round(w.ageMinutes)}m`}`)
      .join('; ')} -- the board-advancement loop may be stalled (INTAKE_ADVANCE_SWEEP_ENABLED / DISABLE_QC_REVIEW_SWEEP, a crashed process, or a hung DB lock). Check scheduler liveness on this box.`;

  notifySystem(message, { agent: 'sweep-liveness', action: 'escalate' });

  try {
    run(
      `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, NULL, ?, ?)`,
      [uuidv4(), EVT_SWEEP_LIVENESS_ALERT, message, ranAt],
    );
  } catch {
    /* cooldown marker is best-effort -- the notifySystem() call above already fired */
  }

  return { ranAt, staleJobs: staleJobNames, alerted: true };
}
