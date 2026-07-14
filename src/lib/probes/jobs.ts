/**
 * Background jobs probe — reports the size of the execution queue and whether
 * any task is stuck in `in_progress` state for an unreasonable length of time.
 *
 * This is the closest current proxy for "cron scheduler running" since Track
 * A1 owns scheduler instrumentation. We surface the queue depth and the
 * oldest in-flight task so the operator can spot stalls.
 *
 * For actual PER-JOB cron-scheduler liveness (does the loop still tick at
 * all), see src/lib/jobs/sweep-liveness.ts (C-09 / U40) — that is the real
 * "watch the watchers" signal this file's own doc comment names as missing;
 * this probe only ever inspects task rows, never the scheduler's own ticks.
 */

import { getDb } from '@/lib/db';
import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';

const STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const BUSY_QUEUE_DEPTH = 25;
const DEGRADED_QUEUE_DEPTH = 100;

export async function probeJobs(): Promise<ProbeResult> {
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
        // rows on every box, always. The working-task count was structurally
        // zero and the "oldest in-flight task" stuck-detection could never
        // fire. Also add archived_at IS NULL to the pending-count filter so a
        // soft-archived (but not done/review) task never inflates the queue
        // depth used for the busy/degraded thresholds below.
        const pending = db
          .prepare(
            "SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('done', 'review') AND archived_at IS NULL"
          )
          .get() as { n: number };
        const working = db
          .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'in_progress'")
          .get() as { n: number };
        const oldestWorkingRow = db
          .prepare(
            "SELECT id, updated_at FROM tasks WHERE status = 'in_progress' ORDER BY updated_at ASC LIMIT 1"
          )
          .get() as { id: string; updated_at: string } | undefined;

        let status: ProbeResult['status'] = 'live';
        let error: string | undefined;

        if (oldestWorkingRow?.updated_at) {
          const ageMs = Date.now() - new Date(oldestWorkingRow.updated_at + 'Z').getTime();
          if (Number.isFinite(ageMs) && ageMs > STUCK_THRESHOLD_MS) {
            status = 'degraded';
            error = `task ${oldestWorkingRow.id} stuck working for ${Math.round(ageMs / 60000)}m`;
          }
        }

        if (pending.n >= DEGRADED_QUEUE_DEPTH && status === 'live') {
          status = 'degraded';
          error = `${pending.n} pending tasks`;
        } else if (pending.n >= BUSY_QUEUE_DEPTH && status === 'live') {
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
