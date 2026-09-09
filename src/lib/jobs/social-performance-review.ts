/**
 * src/lib/jobs/social-performance-review.ts — F40 cadence review job (CC).
 *
 * Runs on the agreed cadence (scheduler.ts: every 6 hours; the review itself
 * is a CADENCE evaluation — a company's reviews fire at most once per its
 * cadence window, default weekly). Per company with observable outcomes it:
 *
 *   1. reads that company's OWN metric observations (never another
 *      company's — cross-client isolation is enforced by the company-scoped
 *      query, not by convention),
 *   2. aggregates per metric with UNKNOWN preserved (never zero-filled),
 *   3. records a review whose recommendation cites the actual posts and
 *      windows, flags low samples as tentative, and proposes only content
 *      changes (format/hook/timing/creative) — never provider/model or
 *      publishing-policy changes (F31/F37 client-choice surfaces),
 *   4. leaves spending/content increases OUT of tentative conclusions.
 *
 * No live network calls: the job reads what the ingest seam already stored.
 */

import { queryAll } from '@/lib/db';
import {
  DEFAULT_REVIEW_CADENCE,
  MIN_SAMPLE_FOR_CONFIDENCE,
  aggregateMetric,
  latestMetricsForCompany,
  recordPerformanceReview,
  type MetricAggregate,
  type ReviewRecord,
} from '@/lib/social/measured-outcomes';

/** Review cadence per company, env-overridable (hours). Default weekly.
 *  Read PER CALL (not module load) so a box can retune the cadence without a
 *  restart and tests can shrink the window. */
function reviewCadenceHours(): number {
  return Math.max(1, parseInt(process.env.SOCIAL_PERFORMANCE_REVIEW_HOURS || '168', 10));
}
/** Minimum posts before a company has anything to review at all. */
const MIN_POSTS_FOR_REVIEW = 1;

export interface CompanyReviewSummary {
  company_id: string;
  action: 'reviewed' | 'insufficient-data' | 'recent';
  review?: ReviewRecord;
  tentative?: boolean;
  reason?: string;
}

function companyReviewCutoff(cadenceHours: number): string {
  return new Date(Date.now() - cadenceHours * 3600_000).toISOString();
}

/**
 * One sweep across companies that have published outcomes. Deterministic and
 * read-only with respect to provider/model/publishing policy.
 */
export async function runSocialPerformanceReviewSweep(): Promise<{
  scanned: number;
  reviewed: number;
  skipped: number;
}> {
  // Companies are discovered from their OWN outcome rows only; there is no
  // global company table join here, so one company's data can never inform
  // another's review.
  const companies = queryAll<{ company_id: string }>(
    `SELECT DISTINCT company_id FROM social_metrics`,
  );
  let reviewed = 0;
  let skipped = 0;
  const scanned = companies.length;

  for (const { company_id: companyId } of companies) {
    const summary = reviewCompany(companyId);
    if (summary.action === 'reviewed') reviewed += 1;
    else skipped += 1;
  }
  return { scanned, reviewed, skipped };
}

/** Review one company. Exposed for tests and the API route. */
export function reviewCompany(companyId: string): CompanyReviewSummary {
  const metrics = latestMetricsForCompany(companyId, { limit: 1000 });
  const posts = [...new Set(metrics.map((m) => m.post_id))].filter(Boolean);
  if (posts.length < MIN_POSTS_FOR_REVIEW) {
    return { company_id: companyId, action: 'insufficient-data', reason: 'no published posts with observations' };
  }
  // Cadence: a review inside the window is a no-op (agreed cadence, not spam).
  const last = queryAll<{ reviewed_at: string }>(
    `SELECT reviewed_at FROM social_performance_reviews
      WHERE company_id = ? AND cadence = ?
      ORDER BY reviewed_at DESC LIMIT 1`,
    [companyId, DEFAULT_REVIEW_CADENCE],
  )[0];
  const cutoff = companyReviewCutoff(reviewCadenceHours());
  if (last && last.reviewed_at > cutoff) {
    return { company_id: companyId, action: 'recent', reason: 'within cadence window' };
  }

  const metricNames = [...new Set(metrics.map((m) => m.metric))];
  const aggregates = metricNames
    .map((metric) => aggregateMetric(metrics, metric))
    .filter((a: MetricAggregate) => a.known_count + a.unknown_count > 0);

  const windows = posts.slice(0, 20).map((postId) => {
    const rows = metrics.filter((m) => m.post_id === postId);
    const withWindow = rows.find((r) => r.window_start || r.window_end);
    return {
      post_id: postId,
      window_start: withWindow?.window_start ?? null,
      window_end: withWindow?.window_end ?? null,
    };
  });

  const sampleSize = aggregates.reduce((acc, a) => acc + a.known_count, 0);
  const allUnknown = sampleSize === 0;
  const recommendation: string | undefined = allUnknown
    ? 'Every metric observation in the window is UNKNOWN (the provider reported nothing). '
      + 'No performance conclusion is drawn — no format, hook, timing or creative change and no spend change follows from missing data.'
    : undefined;

  const review = recordPerformanceReview({
    company_id: companyId,
    posts_reviewed: posts,
    windows,
    aggregates,
    recommendation,
    cadence: DEFAULT_REVIEW_CADENCE,
    proposals: sampleSize >= MIN_SAMPLE_FOR_CONFIDENCE ? [
      {
        kind: 'content-experiment',
        // One variable at a time, only when volume permits. Tentative
        // conclusions never receive a proposal at all.
        variable: 'timing',
        requires: 'client approval before any change; never provider/model or publishing policy',
      },
    ] : [],
  });
  return { company_id: companyId, action: 'reviewed', review, tentative: review.tentative };
}
