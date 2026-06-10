/**
 * PRD 2.14 — Monthly LSS Control Review Job
 *
 * On the 1st of each month at 08:00 America/New_York, computes a Lean Six Sigma
 * control-style review for the just-ended month:
 *   - Company health score/grade (last 30 days)
 *   - Defect rate + rework rate per department
 *   - Waste metrics (stale loops killed; tokens-per-task where data exists)
 *   - Per-department breakdown
 *
 * Artifacts written:
 *   1. One row in `lss_control_reviews` (auditable history).
 *   2. An `events` row (type='qc_review', [LSS-CONTROL-REVIEW] prefix) visible
 *      in the Live Feed — routes to the CEO/master agent so it surfaces at the top.
 *   3. A `recommendations` row (category='watch', department_id='company') when
 *      the company grade dropped vs the prior review.
 *
 * Idempotency:
 *   A second run in the same calendar month is a no-op — guarded by period_end
 *   dedup in `lss_control_reviews`. Returns `skippedReason` when skipping.
 *
 * Opt-out:
 *   DISABLE_LSS_CONTROL_REVIEW=1 — skip the job on this box.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@/lib/db';
import { computeCompanyHealth } from '@/lib/grading';

// ── Exported cron config (consumed by scheduler.ts) ─────────────────────────

/** 1st of each month at 08:00 in the timezone below. */
export const LSS_CONTROL_REVIEW_CRON_EXPR = '0 8 1 * *';
export const LSS_CONTROL_REVIEW_CRON_TIMEZONE = 'America/New_York';

// ── Result shape ─────────────────────────────────────────────────────────────

export interface LssControlReviewResult {
  reviewId: string;
  /** Set when the job ran and produced a review. */
  companyScore: number | null;
  /** Set when the job exited early — second run in same month, or env opt-out. */
  skippedReason?: string;
}

// ── Job logic ─────────────────────────────────────────────────────────────────

/**
 * Run the monthly LSS control review. Safe to call directly in tests.
 * The scheduler wraps this in the standard cron handler.
 */
export async function runLssControlReview(): Promise<LssControlReviewResult> {
  const reviewId = uuidv4();

  // Opt-out knob
  if (
    process.env.DISABLE_LSS_CONTROL_REVIEW === '1' ||
    process.env.DISABLE_LSS_CONTROL_REVIEW === 'true'
  ) {
    return {
      reviewId,
      companyScore: null,
      skippedReason: 'DISABLE_LSS_CONTROL_REVIEW env is set',
    };
  }

  const now = new Date();
  const db = getDb();

  // ── Period calculation ───────────────────────────────────────────────────
  // period_end = start of this month (exclusive upper bound)
  // period_start = start of last month
  const periodEnd = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const periodStart = prevMonth.toISOString().slice(0, 10);

  // ── Idempotency guard ────────────────────────────────────────────────────
  const existing = db.prepare(
    `SELECT id FROM lss_control_reviews WHERE period_end = ? LIMIT 1`
  ).get(periodEnd) as { id: string } | undefined;

  if (existing) {
    return {
      reviewId: existing.id,
      companyScore: null,
      skippedReason: `Already ran for period ending ${periodEnd} (review ${existing.id})`,
    };
  }

  // ── Compute health for last 30 days ─────────────────────────────────────
  const health = computeCompanyHealth(db, { windowDays: 30 });
  const lss = health.lss;

  // ── Build narrative markdown ─────────────────────────────────────────────
  const gradeStr = health.grade ?? 'N/A (insufficient data)';
  const scoreStr = health.score !== null ? `${Math.round(health.score)}/100` : 'N/A';
  const defectStr = lss?.defectRate !== null && lss?.defectRate !== undefined
    ? `${lss.defectRate}%`
    : 'no data';
  const reworkStr = lss?.reworkRate !== null && lss?.reworkRate !== undefined
    ? `${lss.reworkRate}%`
    : 'no data';
  const staleStr = lss?.staleLoopsKilled ?? 0;
  const tokensStr = lss?.tokensPerTask !== null && lss?.tokensPerTask !== undefined
    ? `${lss.tokensPerTask} tokens/task`
    : `no data — ${lss?.tokensPerTaskDetail ?? 'bridge does not emit token counts'}`;

  const deptLines = health.departments.map((d) => {
    const defRate = d.lss?.defectRate.score !== null && d.lss?.defectRate.score !== undefined
      ? `${d.lss.defectRate.score}%`
      : 'no data';
    const rewRate = d.lss?.reworkRate.score !== null && d.lss?.reworkRate.score !== undefined
      ? `${d.lss.reworkRate.score}%`
      : 'no data';
    const stale = d.lss?.staleLoopsKilled ?? 0;
    const gradeTag = d.grade ? ` [${d.grade}]` : ' [—]';
    return `- **${d.name}**${gradeTag}: defect ${defRate}, rework ${rewRate}, stale loops ${stale}`;
  });

  const worstLines = health.worstTrending.map(
    (e) => `- **${e.name}** ↓${Math.abs(Math.round(e.delta))} pts — ${e.failingInput}: ${e.detail}`
  );

  const narrative = [
    `# LSS Monthly Control Review — ${periodStart} → ${periodEnd}`,
    '',
    `**Company Grade:** ${gradeStr}  |  **Score:** ${scoreStr}`,
    `**Defect Rate:** ${defectStr}  |  **Rework Rate:** ${reworkStr}`,
    `**Stale Loops Killed (waste):** ${staleStr}  |  **Tokens/Task:** ${tokensStr}`,
    '',
    '## Department Breakdown',
    '',
    ...deptLines,
    '',
    ...(worstLines.length > 0
      ? ['## Worst Trending', '', ...worstLines, '']
      : []),
    `_Generated ${now.toISOString()}_`,
  ].join('\n');

  // ── Insert review row ────────────────────────────────────────────────────
  const wasteSummary = JSON.stringify({
    tokensPerTask: lss?.tokensPerTask ?? null,
    staleLoopsKilled: lss?.staleLoopsKilled ?? 0,
  });

  const deptBreakdown = JSON.stringify(
    health.departments.map((d) => ({
      slug: d.slug,
      name: d.name,
      score: d.score,
      grade: d.grade,
      defectRate: d.lss?.defectRate.score ?? null,
      reworkRate: d.lss?.reworkRate.score ?? null,
      staleLoopsKilled: d.lss?.staleLoopsKilled ?? 0,
    }))
  );

  db.prepare(
    `INSERT INTO lss_control_reviews
       (id, period_start, period_end, company_score, company_grade,
        defect_rate, rework_rate, waste_summary, department_breakdown, narrative, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    reviewId,
    periodStart,
    periodEnd,
    health.score,
    health.grade,
    lss?.defectRate ?? null,
    lss?.reworkRate ?? null,
    wasteSummary,
    deptBreakdown,
    narrative,
    now.toISOString(),
  );

  // ── Write CEO-visible event (type='qc_review' — Live Feed renders this) ──
  // Resolve CEO/master agent the same way qc-scorer.ts:790–798 does.
  let ceoAgentId: string | null = null;
  try {
    const agentRow = db.prepare(
      `SELECT id FROM agents WHERE is_master = 1
       AND (workspace_id = 'master-orchestrator' OR workspace_id = 'ceo')
       LIMIT 1`
    ).get() as { id: string } | undefined;
    ceoAgentId = agentRow?.id ?? null;
  } catch { /* no CEO agent — event is still visible without agent_id */ }

  const eventMsg =
    `[LSS-CONTROL-REVIEW] ${periodStart}→${periodEnd}: grade=${gradeStr}, ` +
    `defect=${defectStr}, rework=${reworkStr}, waste=${staleStr} stale loops. ` +
    `Review ID: ${reviewId}`;

  db.prepare(
    `INSERT INTO events (id, type, agent_id, message, created_at)
     VALUES (?, 'qc_review', ?, ?, ?)`
  ).run(uuidv4(), ceoAgentId, eventMsg, now.toISOString());

  // ── Upsert recommendations row when grade dropped vs prior review ────────
  try {
    const priorReview = db.prepare(
      `SELECT company_score, company_grade
       FROM lss_control_reviews
       WHERE period_end < ?
       ORDER BY period_end DESC
       LIMIT 1`
    ).get(periodEnd) as { company_score: number | null; company_grade: string | null } | undefined;

    const currentScore = health.score;
    const priorScore = priorReview?.company_score ?? null;
    const dropped = currentScore !== null && priorScore !== null && currentScore < priorScore;

    if (dropped) {
      const recId = uuidv4();
      const recMsg =
        `Company health dropped from ${Math.round(priorScore)}/100 (${priorReview!.company_grade}) ` +
        `to ${Math.round(currentScore)}/100 (${health.grade}) this month. ` +
        `Defect rate: ${defectStr}. Rework rate: ${reworkStr}. Review LSS control report for root cause.`;

      db.prepare(
        `INSERT INTO recommendations
           (id, category, department_id, message, status, created_at, updated_at)
         VALUES (?, 'watch', 'company', ?, 'active', ?, ?)
         ON CONFLICT DO NOTHING`
      ).run(recId, recMsg, now.toISOString(), now.toISOString());
    }
  } catch {
    // recommendations upsert is non-fatal — review was already written
  }

  console.log(
    `[lss-control-review] Review ${reviewId} written for ${periodStart}→${periodEnd}: ` +
    `grade=${gradeStr}, score=${scoreStr}, defect=${defectStr}, rework=${reworkStr}, stale=${staleStr}`
  );

  return { reviewId, companyScore: health.score };
}
