/**
 * Background jobs probe — reports whether the background jobs that move the
 * board are actually running, plus the size of the execution queue and whether
 * any task is stuck in `in_progress` state for an unreasonable length of time.
 *
 * The real per-job signal is the scheduler's own tick ledger: this probe reads
 * `getWatchedJobLiveness()` from src/lib/jobs/board-jobs-watchdog.ts — the same
 * "watch the watchers" signal the watchdog itself uses — instead of inferring
 * scheduler health from a single stuck task row.
 */

import { getDb, parseDbTime } from '@/lib/db';
import {
  getWatchedJobLiveness,
  schedulerLivenessWarmupMinutes,
  WatchedJobLiveness,
} from '@/lib/jobs/board-jobs-watchdog';
import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';

const BUSY_QUEUE_DEPTH = 25;
const DEFAULT_STUCK_MINUTES = 180;

export async function probeJobs(
  uptimeSeconds: number = process.uptime()
): Promise<ProbeResult> {
  const start = Date.now();

  return withTimeout<ProbeResult>(
    async () => {
      try {
        const db = getDb();
        const tablePresent = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
          )
          .get();

        if (!tablePresent) {
          return {
            component: 'jobs',
            label: 'Background Jobs',
            status: 'unknown',
            latencyMs: Date.now() - start,
            detail: { tablePresent: false },
            probedAt: new Date().toISOString(),
          };
        }

        // C-09 / U40: 'working' is NOT one of the 10 canonical task statuses
        // (types.ts TaskStatus — the real in-flight value is 'in_progress'), so
        // every query below that filtered on status = 'working' matched zero
        // rows on every box, always. 'blocked' is also excluded from the
        // backlog count: a blocked card is waiting on a human, not on a job.
        const pending = db
          .prepare(
            "SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('done', 'review', 'blocked') AND archived_at IS NULL"
          )
          .get() as { n: number };
        const working = db
          .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'in_progress'")
          .get() as { n: number };
        const inProgressRows = db
          .prepare(
            "SELECT id, updated_at FROM tasks WHERE status = 'in_progress' AND archived_at IS NULL ORDER BY updated_at ASC"
          )
          .all() as { id: string; updated_at: string }[];

        // Read the stuck-card threshold the way the sweep does, at CALL time, so
        // a runtime env override takes effect on the next probe tick.
        const rawThreshold = parseFloat(
          process.env.STUCK_IN_PROGRESS_MINUTES || String(DEFAULT_STUCK_MINUTES)
        );
        const staleMinutes =
          Number.isFinite(rawThreshold) && rawThreshold > 0
            ? rawThreshold
            : DEFAULT_STUCK_MINUTES;

        let staleCount = 0;
        let unparseableTimestamps = 0;
        const now = Date.now();
        for (const row of inProgressRows) {
          const ageMs = now - parseDbTime(row.updated_at);
          if (!Number.isFinite(ageMs)) {
            // An unreadable timestamp is not evidence of a stuck card.
            unparseableTimestamps += 1;
            continue;
          }
          if (ageMs > staleMinutes * 60 * 1000) staleCount += 1;
        }

        // An operator switching a job off is a decision, not a fault.
        let allWatched: WatchedJobLiveness[];
        try {
          allWatched = getWatchedJobLiveness();
        } catch (err) {
          // A counted row that is `unknown` shows Degraded, which is correct:
          // the app cannot tell whether its jobs run.
          return {
            component: 'jobs',
            label: 'Background Jobs',
            status: 'unknown',
            latencyMs: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
            probedAt: new Date().toISOString(),
          };
        }
        const watched = allWatched.filter((j) => !j.disabled);
        const warmingUp =
          uptimeSeconds / 60 < schedulerLivenessWarmupMinutes(watched);
        const silent = watched.filter((j) => j.stale && !warmingUp);
        const failing = watched.filter(
          (j) =>
            j.consecutiveFailures >= 3 ||
            (!warmingUp && j.failed && j.consecutiveFailures === 0)
        );

        const oldestWorkingRow = inProgressRows[0];

        let status: ProbeResult['status'] = 'live';
        let error: string | undefined;
        const notNormal = [
          ...new Set([...silent, ...failing].map((j) => j.jobName)),
        ];
        if (notNormal.length > 0) {
          status = 'degraded';
          error = `Background jobs not running normally: ${notNormal.join(', ')}`;
        } else if (staleCount >= 1 || pending.n >= BUSY_QUEUE_DEPTH) {
          status = 'busy';
        }

        return {
          component: 'jobs',
          label: 'Background Jobs',
          status,
          latencyMs: Date.now() - start,
          error,
          detail: {
            pendingTasks: pending.n,
            workingTasks: working.n,
            oldestWorkingTask: oldestWorkingRow?.id || null,
            oldestWorkingTaskUpdatedAt: oldestWorkingRow?.updated_at || null,
            staleInProgress: staleCount,
            unparseableTimestamps,
            warmingUp,
            watchedJobs: allWatched.map((j) => ({
              jobName: j.jobName,
              stale: j.stale,
              failed: j.failed,
              disabled: j.disabled,
              ageMinutes: j.ageMinutes,
            })),
          },
          probedAt: new Date().toISOString(),
        };
      } catch (err) {
        return {
          component: 'jobs',
          label: 'Background Jobs',
          status: 'offline',
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
          probedAt: new Date().toISOString(),
        };
      }
    },
    PROBE_TIMEOUT_MS,
    () => ({
      component: 'jobs',
      label: 'Background Jobs',
      status: 'offline',
      latencyMs: Date.now() - start,
      error: 'probe timed out',
      probedAt: new Date().toISOString(),
    })
  );
}
