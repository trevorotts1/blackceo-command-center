/**
 * QC Review Sweep — catch tasks stuck in the `review` column.
 *
 * Problem: tasks that arrived in `review` before the QC scorer was wired to the
 * agent-completion / execution-watcher paths never had `runQCOnReview()` called.
 * They rot in the Review/QC column indefinitely because no scorer ever fires.
 *
 * This job runs every 2 minutes and scores any `review` task that has NOT
 * received a `qc_review` event in the last 10 minutes. `runQCOnReview` already
 * guards `status === 'review'` internally, so calling it on an already-processed
 * task is a safe no-op.
 *
 * Disable: DISABLE_QC_REVIEW_SWEEP=1
 *
 * Structure mirrors weekly-done-clear.ts / general-task-recurrence.ts.
 */

import { queryAll, run } from '@/lib/db';
import { runQCOnReview } from '@/lib/qc-scorer';

// ── Types ────────────────────────────────────────────────────────────────────

export interface QCReviewSweepResult {
  scanned: number;
  scored: number;
  ranAt: string;
  skippedReason?: string;
}

// ── Main sweep ───────────────────────────────────────────────────────────────

/**
 * Scan `review` tasks that have no recent (≤10 min) `qc_review` event and
 * call `runQCOnReview()` for each. Fire-and-forget safe; any per-task error
 * is caught internally by `runQCOnReview` and leaves the task in review.
 */
export async function runQCReviewSweep(): Promise<QCReviewSweepResult> {
  const ranAt = new Date().toISOString();

  if (
    process.env.DISABLE_QC_REVIEW_SWEEP === '1' ||
    process.env.DISABLE_QC_REVIEW_SWEEP === 'true'
  ) {
    return { scanned: 0, scored: 0, ranAt, skippedReason: 'DISABLE_QC_REVIEW_SWEEP env is set' };
  }

  // Select review tasks that haven't been QC'd in the last 10 minutes.
  // The NOT EXISTS guard prevents double-scoring tasks that are already being
  // processed by a concurrent webhook call.
  const stuckRows = queryAll<{ id: string; title: string }>(
    `SELECT t.id, t.title
     FROM tasks t
     WHERE t.status = 'review'
       AND t.archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM events e
         WHERE e.task_id = t.id
           AND e.type = 'qc_review'
           AND e.created_at >= datetime('now', '-10 minutes')
       )
     ORDER BY t.updated_at ASC`,
    [],
  );

  if (stuckRows.length === 0) {
    return { scanned: 0, scored: 0, ranAt };
  }

  console.log(`[qc-review-sweep] Found ${stuckRows.length} stuck review task(s) — scoring now`);

  let scored = 0;
  for (const row of stuckRows) {
    try {
      const result = await runQCOnReview(row.id);
      if (result !== null) {
        scored++;
        console.log(
          `[qc-review-sweep] Task "${row.title}" (${row.id}): ` +
            `score ${result.score.toFixed(1)}/10 — ${result.pass ? 'PASS→done' : 'FAIL→backlog'}`,
        );
      }
    } catch (err) {
      console.error(`[qc-review-sweep] Error scoring task ${row.id}:`, (err as Error).message);
    }
  }

  return { scanned: stuckRows.length, scored, ranAt };
}
