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
 * PROVIDER-DOWN DEFERRAL (Point 6 fix 1): a task the QC scorer parked with a
 * [QC-DEFERRED-PROVIDER-DOWN] marker (a key is configured but the provider was
 * down) is NOT human-required — it must be auto-rescored as soon as the provider
 * returns. Such markers are excluded from the 10-minute "recently scored" block
 * and instead governed by a SHORTER retry window (QC_DEFERRED_RETRY_MINUTES,
 * default 5), so QC recovers fast on a blip without hammering a still-down
 * provider. When the provider is back the re-score produces an `llm` result and
 * the task flows through the normal pass / fail / reroute path.
 *
 * NO-KEY TERMINAL (QC-02): a keyless box can NEVER auto-advance review→done. To
 * stop re-scoring such a task every ~10 min forever, the QC scorer escalates it
 * ONCE (after QC_HEURISTIC_NO_KEY_MAX_PASSES passes, default 3) to a terminal
 * [QC-HEURISTIC-FINAL] "needs-key / manual-promote" state. This sweep excludes
 * that marker PERMANENTLY (no time window) — distinct from [QC-DEFERRED-PROVIDER-
 * DOWN], which keeps retrying. The card stays board-visible in Review / QC for a
 * human to manually promote (or to add an LLM key, which re-enables scoring).
 *
 * JUDGE-FAILURE TERMINAL: the deferral above retries on the assumption the
 * provider RETURNS. When that assumption is false it retried forever and told no
 * one — one live board sat SIX DAYS because the judge (a REASONING model) was
 * starved by a 300-token completion budget, answered with EMPTY content, and the
 * scorer called that "provider-down". The scorer now bounds the deferrals
 * (QC_JUDGE_FAILURE_MAX_PASSES, default 12 ≈ 1h at the 5-min cadence) and then
 * escalates ONCE to a terminal [QC-JUDGE-FAILED-FINAL] naming the OBSERVED
 * failure (unreachable vs empty vs malformed), the judge model, and the exact
 * endpoint it dialled. This sweep excludes THAT marker PERMANENTLY too — it is
 * the escalated "a human must look at the judge" state, and re-scoring it would
 * just restore the silent loop the bound exists to kill.
 *
 * The terminal marker is deliberately NOT named "…PROVIDER-DOWN-FINAL": on the
 * real incident the provider was UP the whole time. An escalation that asserts a
 * guessed category is what cost the six days in the first place.
 *
 * Disable: DISABLE_QC_REVIEW_SWEEP=1
 *
 * Structure mirrors weekly-done-clear.ts / general-task-recurrence.ts.
 */

import { queryAll, sqlTime, timeNow } from '@/lib/db';
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
  const ranAt = timeNow();

  if (
    process.env.DISABLE_QC_REVIEW_SWEEP === '1' ||
    process.env.DISABLE_QC_REVIEW_SWEEP === 'true'
  ) {
    return { scanned: 0, scored: 0, ranAt, skippedReason: 'DISABLE_QC_REVIEW_SWEEP env is set' };
  }

  // Provider-down deferred tasks retry on a SHORTER cadence than the general
  // 10-minute window (default 5 min; QC_DEFERRED_RETRY_MINUTES-overridable) so QC
  // recovers quickly once the scorer is back, without hammering a still-down one.
  const deferredRetryMin = Math.max(
    1,
    parseInt(process.env.QC_DEFERRED_RETRY_MINUTES || '5', 10) || 5,
  );

  // Select review tasks that haven't been QC'd in the last 10 minutes.
  // The NOT EXISTS guard prevents double-scoring tasks that are already being
  // processed by a concurrent webhook call. A [QC-DEFERRED-PROVIDER-DOWN] marker
  // is a qc_review event but must NOT count toward that 10-minute block — it is
  // governed by the shorter deferred-retry window instead so it is re-scored the
  // moment the window elapses (auto-rescore on provider recovery).
  //
  // QC-02 PERMANENT EXCLUSION: a keyless box escalates a stuck no-key task ONCE
  // to a terminal [QC-HEURISTIC-FINAL] "needs-key / manual-promote" state (see
  // qc-scorer). Such a task can NEVER auto-advance, so re-scoring it every 10 min
  // forever is pure churn — exclude it PERMANENTLY (no time window). This is kept
  // DISTINCT from [QC-DEFERRED-PROVIDER-DOWN], which KEEPS retrying on the short
  // cadence because a key exists and the provider is expected to return.
  const stuckRows = queryAll<{ id: string; title: string }>(
    `SELECT t.id, t.title
     FROM tasks t
     WHERE t.status = 'review'
       AND t.archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM events e
         WHERE e.task_id = t.id
           AND e.type = 'qc_review'
           AND e.message LIKE '%[QC-HEURISTIC-FINAL]%'
       )
       AND NOT EXISTS (
         SELECT 1 FROM events e
         WHERE e.task_id = t.id
           AND e.type = 'qc_review'
           AND e.message LIKE '%[QC-JUDGE-FAILED-FINAL]%'
       )
       AND NOT EXISTS (
         SELECT 1 FROM events e
         WHERE e.task_id = t.id
           AND e.type = 'qc_review'
           AND e.message NOT LIKE '%[QC-DEFERRED-PROVIDER-DOWN]%'
           AND ${sqlTime('e.created_at')} >= datetime('now', '-10 minutes')
       )
       AND NOT EXISTS (
         SELECT 1 FROM events e
         WHERE e.task_id = t.id
           AND e.type = 'qc_review'
           AND e.message LIKE '%[QC-DEFERRED-PROVIDER-DOWN]%'
           AND ${sqlTime('e.created_at')} >= datetime('now', ?)
       )
     ORDER BY t.updated_at ASC`,
    [`-${deferredRetryMin} minutes`],
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
        // B9: the previous string logged 'FAIL→backlog' for EVERY non-pass, but a
        // heuristic (no-key / provider-down) score does NOT move the task — it
        // STAYS in review for human promotion. Only an `llm` fail reroutes. Report
        // the outcome the task actually took so the operator log is truthful.
        const outcome = result.pass
          ? 'PASS→done'
          : result.scoringPath === 'heuristic'
            ? 'HELD in review (heuristic — human review required)'
            : 'FAIL→reroute';
        console.log(
          `[qc-review-sweep] Task "${row.title}" (${row.id}): ` +
            `score ${result.score.toFixed(1)}/10 — ${outcome}`,
        );
      }
    } catch (err) {
      console.error(`[qc-review-sweep] Error scoring task ${row.id}:`, (err as Error).message);
    }
  }

  return { scanned: stuckRows.length, scored, ranAt };
}
