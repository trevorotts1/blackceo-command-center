/**
 * Grading Module — Single Source of Truth (PRD 2.10)
 *
 * Absorbs grade-calculator.ts's scoring logic. Computes per-department grades
 * from FOUR observable DB signals and rolls them up to a company health score.
 *
 * The four PRD-exact inputs per department:
 *   1. throughput     — completed tasks vs created tasks in the rolling window
 *   2. qcPassRate     — share of LLM-scored tasks that passed the 8.5 gate
 *   3. sopCoverage    — share of dispatched tasks that had an SOP attached
 *   4. kpiAttainment  — avg attainment vs role-doc Tier-1 targets in kpi_snapshots
 *
 * DESIGN RULE: every input can return score=null (insufficient data).
 * null MUST render as "insufficient data" in the UI — never 0, never 72.
 *
 * KPI dependency note: kpiAttainment grades against kpi_snapshots.target.
 * Those targets are populated by onboarding when role-doc Tier-1 targets are
 * seeded. When not yet seeded, kpiAttainment returns null with a distinct
 * "No role-doc KPI targets seeded yet" detail so the missing step is visible.
 *
 * Server-side only — no React, no fetch. Takes a db handle so unit tests can
 * inject an isolated fixture DB.
 */

import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Re-exported primitives (grade-calculator.ts imports these as a shim)
// ---------------------------------------------------------------------------

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

/** Score-to-letter mapping per PRD boundaries: A≥90, B≥75, C≥60, D≥40, F<40 */
export function scoreToGrade(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function gradeToColor(grade: Grade): string {
  if (grade === 'A' || grade === 'B') return '#10B981'; // emerald
  if (grade === 'C') return '#F59E0B'; // amber
  return '#EF4444'; // red
}

export function gradeToLabel(grade: Grade): string {
  const labels = { A: 'Excellent', B: 'Good', C: 'Average', D: 'Needs Work', F: 'Critical' };
  return labels[grade];
}

/**
 * Legacy 4-factor formula kept for grade-calculator shim.
 * @deprecated Use computeCompanyHealth / computeDepartmentGrade instead.
 */
export function calculateCompanyScore(params: {
  kpiAchievement: number;
  agentPerformance: number;
  daCompliance: number;
  recommendationFollowThrough: number;
}): number {
  return (
    params.kpiAchievement * 0.40 +
    params.agentPerformance * 0.30 +
    params.daCompliance * 0.15 +
    params.recommendationFollowThrough * 0.15
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GRADING_THRESHOLDS = {
  MIN_TASKS_FOR_THROUGHPUT: 3,
  MIN_QC_RESULTS: 3,
  MIN_DISPATCHED: 3,
  MIN_GRADED_INPUTS: 2,
} as const;

/** Default input weights. Sum must be 1.0. QC weighted highest (defect signal). */
export const DEFAULT_INPUT_WEIGHTS: Record<GradeInputKey, number> = {
  throughput: 0.25,
  qcPassRate: 0.30,
  sopCoverage: 0.20,
  kpiAttainment: 0.25,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GradeInputKey = 'throughput' | 'qcPassRate' | 'sopCoverage' | 'kpiAttainment';

export interface InputScore {
  key: GradeInputKey;
  /** null = insufficient data (never 0 as a fake grade) */
  score: number | null;
  /** denominator that drove the score (tasks, kpis, etc.) */
  sampleSize: number;
  /** human one-liner for the UI insufficient-data or failing-input flag */
  detail: string;
}

export interface DepartmentGrade {
  workspaceId: string;
  slug: string;
  name: string;
  inputs: Record<GradeInputKey, InputScore>;
  /** Weighted avg over inputs WITH data; null if fewer than MIN_GRADED_INPUTS have data */
  score: number | null;
  grade: Grade | null;
  sufficientData: boolean;
  /** PRD 2.14 LSS diagnostic metrics — optional for backward-compat */
  lss?: LssDepartmentMetrics;
}

export interface WorstTrendingEntry {
  slug: string;
  name: string;
  failingInput: GradeInputKey;
  detail: string;
  /** current window score - previous window score (negative = worsening) */
  delta: number;
}

// ---------------------------------------------------------------------------
// LSS (Lean Six Sigma) types — PRD 2.14
// Defect/rework/waste are REPORTED alongside grades, NOT graded inputs.
// They do NOT affect DEFAULT_INPUT_WEIGHTS or the weighted score formula.
// ---------------------------------------------------------------------------

/**
 * Per-department LSS diagnostic metrics.
 * All fields use the same null-for-insufficient-data discipline as InputScore.
 */
export interface LssDepartmentMetrics {
  /** Complement of qcPassRate: % of LLM-graded tasks that did NOT pass.
   *  Computed from the same single query as qcPassRate — never disagrees.
   *  score: null when < MIN_QC_RESULTS LLM rows exist. */
  defectRate: {
    score: number | null;
    sampleSize: number;
    detail: string;
  };
  /** % of tasks that were re-graded at least once (attempt > 1 in task_qc_results).
   *  score: null when < MIN_QC_RESULTS distinct tasks with LLM results. */
  reworkRate: {
    score: number | null;
    sampleSize: number;
    detail: string;
  };
  /** Count of tasks that hit the QC reroute cap and were blocked.
   *  Always an integer (0 = none — not null; a real zero is honest data). */
  staleLoopsKilled: number;
}

/**
 * Company-level LSS aggregate.
 * defectRate/reworkRate are task-count-weighted aggregates from real depts.
 * staleLoopsKilled is a plain sum.
 * tokensPerTask is null (with explanatory detail) unless task_activities.metadata
 * carries token counts — the bridge does not currently emit them.
 */
export interface LssCompanyMetrics {
  defectRate: number | null;
  reworkRate: number | null;
  staleLoopsKilled: number;
  /** null when no per-task token data exists in task_activities.metadata */
  tokensPerTask: number | null;
  /** Explains why tokensPerTask is null, or the computation method when present */
  tokensPerTaskDetail: string;
}

export interface CompanyHealth {
  /** 0-100 task-count-weighted avg; null if no dept has sufficient data */
  score: number | null;
  grade: Grade | null;
  departments: DepartmentGrade[];
  /** Up to 3 departments trending downward, each tagged with their weakest input */
  worstTrending: WorstTrendingEntry[];
  generatedAt: string;
  /** PRD 2.14 LSS metrics — optional so existing callers stay backward-compatible */
  lss?: LssCompanyMetrics;
}

// ---------------------------------------------------------------------------
// Workspace filter — centralized so the UI and module stay in sync
// ---------------------------------------------------------------------------

/**
 * Returns true for workspaces that represent real departments.
 * Excludes seeded demo / default / ZHW scaffolding slugs.
 */
export function isRealDepartment(slug: string): boolean {
  if (!slug) return false;
  if (slug === 'default') return false;
  if (slug.startsWith('acme-')) return false;
  if (slug.startsWith('zhw-')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
}

/** Resolve a workspace's task volume in the window — used as roll-up weight. */
function getWindowTaskVolume(db: Database.Database, workspaceId: string, windowDays: number): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt FROM tasks
     WHERE workspace_id = ?
       AND julianday('now') - julianday(created_at) <= ?`
  ).get(workspaceId, windowDays) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

// ---------------------------------------------------------------------------
// The four input computations
// ---------------------------------------------------------------------------

function computeThroughput(
  db: Database.Database,
  workspaceId: string,
  windowDays: number,
): InputScore {
  const row = (db.prepare(
    `SELECT
       COUNT(*) AS created,
       SUM(CASE WHEN status = 'done'
                 AND julianday('now') - julianday(COALESCE(completed_at, updated_at)) <= ?
                THEN 1 ELSE 0 END) AS completed
     FROM tasks
     WHERE workspace_id = ?
       AND julianday('now') - julianday(created_at) <= ?`
  ).get(windowDays, workspaceId, windowDays)) as { created: number; completed: number } | undefined;

  const created = row?.created ?? 0;
  const completed = row?.completed ?? 0;

  // Insufficient data check uses created count only: if fewer than MIN_TASKS were
  // created in the window, we don't have enough signal regardless of completions.
  if (created < GRADING_THRESHOLDS.MIN_TASKS_FOR_THROUGHPUT) {
    return {
      key: 'throughput',
      score: null,
      sampleSize: created,
      detail: `Insufficient task data (${created} tasks created, need ${GRADING_THRESHOLDS.MIN_TASKS_FOR_THROUGHPUT}+)`,
    };
  }

  // Denominator: max(created, completed) prevents > 100% when clearing backlog
  const denom = Math.max(created, completed);
  const score = Math.min(100, Math.round((completed / denom) * 100));
  return {
    key: 'throughput',
    score,
    sampleSize: created,
    detail: `${completed} completed of ${created} created (${score}%)`,
  };
}

function computeQcPassRate(
  db: Database.Database,
  workspaceId: string,
  windowDays: number,
): InputScore {
  // LLM rows only — heuristic/no-criteria are NOT graded outcomes (PRD 2.4)
  const row = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(passed) AS passes
     FROM task_qc_results
     WHERE workspace_id = ?
       AND scoring_path = 'llm'
       AND julianday('now') - julianday(scored_at) <= ?`
  ).get(workspaceId, windowDays) as { total: number; passes: number } | undefined;

  const total = row?.total ?? 0;

  if (total < GRADING_THRESHOLDS.MIN_QC_RESULTS) {
    return {
      key: 'qcPassRate',
      score: null,
      sampleSize: total,
      detail: `Awaiting QC scoring (${total} LLM-graded results, need ${GRADING_THRESHOLDS.MIN_QC_RESULTS}+)`,
    };
  }

  const passes = row?.passes ?? 0;
  const score = Math.round((passes / total) * 100);
  return {
    key: 'qcPassRate',
    score,
    sampleSize: total,
    detail: `${passes}/${total} tasks passed QC gate (≥8.5) — ${score}%`,
  };
}

function computeSopCoverage(
  db: Database.Database,
  workspaceId: string,
  windowDays: number,
): InputScore {
  // Denominator: tasks with a task_dispatched event in the window for this workspace
  // Numerator: those whose tasks.sop_id IS NOT NULL
  const row = db.prepare(
    `SELECT
       COUNT(DISTINCT e.task_id) AS dispatched,
       SUM(CASE WHEN t.sop_id IS NOT NULL THEN 1 ELSE 0 END) AS with_sop
     FROM events e
     JOIN tasks t ON t.id = e.task_id
     WHERE e.type = 'task_dispatched'
       AND t.workspace_id = ?
       AND julianday('now') - julianday(e.created_at) <= ?`
  ).get(workspaceId, windowDays) as { dispatched: number; with_sop: number } | undefined;

  const dispatched = row?.dispatched ?? 0;

  if (dispatched < GRADING_THRESHOLDS.MIN_DISPATCHED) {
    return {
      key: 'sopCoverage',
      score: null,
      sampleSize: dispatched,
      detail: `Insufficient dispatches (${dispatched}, need ${GRADING_THRESHOLDS.MIN_DISPATCHED}+)`,
    };
  }

  const withSop = row?.with_sop ?? 0;
  const score = Math.round((withSop / dispatched) * 100);
  return {
    key: 'sopCoverage',
    score,
    sampleSize: dispatched,
    detail: `${withSop}/${dispatched} dispatched tasks had an SOP (${score}%)`,
  };
}

function computeKpiAttainment(
  db: Database.Database,
  workspaceId: string,
): InputScore {
  // Use latest snapshot per kpi_id for this workspace (department_id = workspace slug)
  // target must be non-null and > 0 to be gradeable
  let wsSlug: string | null = null;
  try {
    const ws = db.prepare('SELECT slug FROM workspaces WHERE id = ?').get(workspaceId) as
      | { slug: string }
      | undefined;
    wsSlug = ws?.slug ?? workspaceId;
  } catch {
    wsSlug = workspaceId;
  }

  // Check if kpi_snapshots table exists (pre-migration-047 guard)
  const tableCheck = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='kpi_snapshots'`
  ).get() as { name: string } | undefined;

  if (!tableCheck) {
    return {
      key: 'kpiAttainment',
      score: null,
      sampleSize: 0,
      detail: 'No role-doc KPI targets seeded yet (kpi_snapshots table missing)',
    };
  }

  const rows = (db.prepare(
    `SELECT k.kpi_id, k.value, k.target
     FROM kpi_snapshots k
     INNER JOIN (
       SELECT kpi_id, MAX(snapshot_date) AS max_date
       FROM kpi_snapshots
       WHERE (department_id = ? OR department_id = ?)
         AND target IS NOT NULL AND target > 0
       GROUP BY kpi_id
     ) latest ON k.kpi_id = latest.kpi_id AND k.snapshot_date = latest.max_date
     WHERE (k.department_id = ? OR k.department_id = ?)
       AND k.target IS NOT NULL AND k.target > 0`
  ).all(workspaceId, wsSlug, workspaceId, wsSlug)) as Array<{
    kpi_id: string;
    value: number;
    target: number;
  }>;

  if (rows.length === 0) {
    return {
      key: 'kpiAttainment',
      score: null,
      sampleSize: 0,
      detail: 'No role-doc KPI targets seeded yet',
    };
  }

  const avgAttainment = rows.reduce((sum, r) => {
    const att = Math.min(100, Math.round((r.value / r.target) * 100));
    return sum + att;
  }, 0) / rows.length;

  const score = Math.round(avgAttainment);
  return {
    key: 'kpiAttainment',
    score,
    sampleSize: rows.length,
    detail: `Avg ${score}% attainment across ${rows.length} KPI(s) with targets`,
  };
}

// ---------------------------------------------------------------------------
// PRD 2.14 — LSS metric computations
// ---------------------------------------------------------------------------

/**
 * Compute defect rate for a department.
 *
 * A "defect" = an LLM-graded QC result that did NOT pass the 8.5 gate.
 * Uses the EXACT same query as computeQcPassRate (same row, same filter)
 * so defectRate = 100 - qcPassRate arithmetically, but we compute it from
 * a single query to guarantee they never disagree.
 *
 * Insufficient data floor: MIN_QC_RESULTS (same as qcPassRate).
 * score === null when total < 3 — never 0 as a fake grade.
 */
function computeDefectRate(
  db: Database.Database,
  workspaceId: string,
  windowDays: number,
): LssDepartmentMetrics['defectRate'] {
  const row = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(passed) AS passes
     FROM task_qc_results
     WHERE workspace_id = ?
       AND scoring_path = 'llm'
       AND julianday('now') - julianday(scored_at) <= ?`
  ).get(workspaceId, windowDays) as { total: number; passes: number } | undefined;

  const total = row?.total ?? 0;

  if (total < GRADING_THRESHOLDS.MIN_QC_RESULTS) {
    return {
      score: null,
      sampleSize: total,
      detail: `Awaiting QC scoring (${total} LLM-graded results, need ${GRADING_THRESHOLDS.MIN_QC_RESULTS}+)`,
    };
  }

  const passes = row?.passes ?? 0;
  // defectRate = complement of qcPassRate over the same denominator
  const score = Math.round(((total - passes) / total) * 100);
  return {
    score,
    sampleSize: total,
    detail: `${total - passes}/${total} LLM-graded tasks failed QC gate — ${score}% defect rate`,
  };
}

/**
 * Compute rework rate for a department.
 *
 * A task "required rework" if it was sent back at least once:
 * task_qc_results.attempt > 1 (set to qc_reroute_attempts+1 in qc-scorer.ts:650).
 *
 * numerator  = DISTINCT task_id where MAX(attempt) > 1 (was reworked)
 * denominator = DISTINCT task_id with any llm-graded result
 * Both scoped to workspace + window on scored_at.
 *
 * Tasks blocked at the 3-attempt cap count as rework (attempt reached 3+).
 * Insufficient data floor: MIN_QC_RESULTS on denominator → null, not 0.
 */
function computeReworkRate(
  db: Database.Database,
  workspaceId: string,
  windowDays: number,
): LssDepartmentMetrics['reworkRate'] {
  const row = db.prepare(
    `SELECT
       COUNT(DISTINCT task_id) AS total_tasks,
       SUM(CASE WHEN max_attempt > 1 THEN 1 ELSE 0 END) AS reworked_tasks
     FROM (
       SELECT task_id, MAX(attempt) AS max_attempt
       FROM task_qc_results
       WHERE workspace_id = ?
         AND scoring_path = 'llm'
         AND julianday('now') - julianday(scored_at) <= ?
       GROUP BY task_id
     ) task_attempts`
  ).get(workspaceId, windowDays) as { total_tasks: number; reworked_tasks: number } | undefined;

  const totalTasks = row?.total_tasks ?? 0;

  if (totalTasks < GRADING_THRESHOLDS.MIN_QC_RESULTS) {
    return {
      score: null,
      sampleSize: totalTasks,
      detail: `Insufficient QC history for rework signal (${totalTasks} tasks, need ${GRADING_THRESHOLDS.MIN_QC_RESULTS}+)`,
    };
  }

  const reworkedTasks = row?.reworked_tasks ?? 0;
  const score = Math.round((reworkedTasks / totalTasks) * 100);
  return {
    score,
    sampleSize: totalTasks,
    detail: `${reworkedTasks}/${totalTasks} tasks required rework (re-graded) — ${score}% rework rate`,
  };
}

/**
 * Count tasks that hit the QC reroute cap and were blocked in the window.
 * Source: tasks WHERE status='blocked' AND qc_reroute_attempts >= QC_MAX_REROUTES,
 * windowed on updated_at (blocked tasks never get completed_at — trg_tasks_completed_at
 * only fires on status='done').
 *
 * Always returns an integer — never null (0 = none, which is truthful).
 */
function computeStaleLoopsKilled(
  db: Database.Database,
  workspaceId: string,
  windowDays: number,
): number {
  // QC_MAX_REROUTES default is 3 (from env QC_MAX_REROUTES or default 3)
  // We use 3 as the hard-coded floor here — matches qc-scorer.ts default.
  const QC_MAX_REROUTES_FLOOR = parseInt(process.env.QC_MAX_REROUTES || '3', 10);

  const row = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM tasks
     WHERE workspace_id = ?
       AND status = 'blocked'
       AND qc_reroute_attempts >= ?
       AND julianday('now') - julianday(updated_at) <= ?`
  ).get(workspaceId, QC_MAX_REROUTES_FLOOR, windowDays) as { cnt: number } | undefined;

  return row?.cnt ?? 0;
}

/**
 * Probe task_activities.metadata for per-task token counts.
 * Returns { value: number, detail } when token metadata exists;
 * returns { value: null, detail } with an explanatory message when it doesn't.
 *
 * HONEST: We do NOT invent a number from provider_usage (account-aggregate).
 * The null state is the correct output when the bridge doesn't emit token counts.
 */
function computeTokensPerTask(
  db: Database.Database,
  workspaceId: string,
  windowDays: number,
): { value: number | null; detail: string } {
  // Check if task_activities table exists (pre-migration guard)
  const tableCheck = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='task_activities'`
  ).get() as { name: string } | undefined;

  if (!tableCheck) {
    return {
      value: null,
      detail: 'No per-task token data captured (task_activities table missing)',
    };
  }

  // Look for rows in task_activities for completed tasks in this workspace where
  // metadata JSON contains a 'tokens' or 'total_tokens' key.
  const rows = db.prepare(
    `SELECT ta.metadata
     FROM task_activities ta
     JOIN tasks t ON t.id = ta.task_id
     WHERE t.workspace_id = ?
       AND t.status = 'done'
       AND ta.metadata IS NOT NULL
       AND julianday('now') - julianday(ta.created_at) <= ?`
  ).all(workspaceId, windowDays) as Array<{ metadata: string }>;

  const tokenCounts: number[] = [];
  for (const row of rows) {
    try {
      const meta = JSON.parse(row.metadata);
      const tokens = meta?.tokens ?? meta?.total_tokens ?? null;
      if (typeof tokens === 'number' && tokens > 0) {
        tokenCounts.push(tokens);
      }
    } catch {
      // non-JSON metadata — skip
    }
  }

  if (tokenCounts.length === 0) {
    return {
      value: null,
      detail: 'No per-task token data captured (bridge does not emit token counts)',
    };
  }

  const avg = Math.round(tokenCounts.reduce((s, n) => s + n, 0) / tokenCounts.length);
  return {
    value: avg,
    detail: `Avg ${avg} tokens/completed-task (${tokenCounts.length} tasks with token metadata)`,
  };
}

// ---------------------------------------------------------------------------
// Department grade computation
// ---------------------------------------------------------------------------

/**
 * Compute a single department's grade from the four PRD inputs.
 * Returns null score when fewer than MIN_GRADED_INPUTS inputs have data.
 */
export function computeDepartmentGrade(
  db: Database.Database,
  ws: WorkspaceRow,
  windowDays: number,
  weights?: Record<GradeInputKey, number>,
): DepartmentGrade {
  const w = weights || DEFAULT_INPUT_WEIGHTS;

  const inputs: Record<GradeInputKey, InputScore> = {
    throughput: computeThroughput(db, ws.id, windowDays),
    qcPassRate: computeQcPassRate(db, ws.id, windowDays),
    sopCoverage: computeSopCoverage(db, ws.id, windowDays),
    kpiAttainment: computeKpiAttainment(db, ws.id),
  };

  // Only score inputs with data; re-normalize weights across present inputs
  const presentKeys = (Object.keys(inputs) as GradeInputKey[]).filter(
    (k) => inputs[k].score !== null
  );
  const sufficientData = presentKeys.length >= GRADING_THRESHOLDS.MIN_GRADED_INPUTS;

  let score: number | null = null;
  if (sufficientData) {
    const totalWeight = presentKeys.reduce((s, k) => s + w[k], 0);
    const weightedSum = presentKeys.reduce((s, k) => {
      return s + (inputs[k].score! * w[k]);
    }, 0);
    score = Math.round((weightedSum / totalWeight) * 100) / 100;
  }

  // PRD 2.14: LSS diagnostic metrics (reported alongside grade, NOT graded)
  const lss: LssDepartmentMetrics = {
    defectRate: computeDefectRate(db, ws.id, windowDays),
    reworkRate: computeReworkRate(db, ws.id, windowDays),
    staleLoopsKilled: computeStaleLoopsKilled(db, ws.id, windowDays),
  };

  return {
    workspaceId: ws.id,
    slug: ws.slug,
    name: ws.name,
    inputs,
    score,
    grade: score !== null ? scoreToGrade(score) : null,
    sufficientData,
    lss,
  };
}

// ---------------------------------------------------------------------------
// Company health roll-up
// ---------------------------------------------------------------------------

export interface CompanyHealthOpts {
  windowDays?: number;
  weights?: Record<GradeInputKey, number>;
}

/**
 * Compute company-wide health: per-dept grades + task-count-weighted roll-up.
 * Excludes non-real workspaces (default, acme-*, zhw-*).
 * Returns score=null and grade=null when no department has sufficient data.
 */
export function computeCompanyHealth(
  db: Database.Database,
  opts?: CompanyHealthOpts,
): CompanyHealth {
  const windowDays = opts?.windowDays ?? 30;
  const weights = opts?.weights;

  // Load all real workspaces
  const allWorkspaces = db.prepare(
    `SELECT id, slug, name FROM workspaces ORDER BY sort_order ASC, name ASC`
  ).all() as WorkspaceRow[];

  const realWorkspaces = allWorkspaces.filter((ws) => isRealDepartment(ws.slug));

  // Compute per-department grades
  const departments: DepartmentGrade[] = realWorkspaces.map((ws) =>
    computeDepartmentGrade(db, ws, windowDays, weights)
  );

  // Company score: task-count-weighted average of depts with sufficient data
  const scoredDepts = departments.filter((d) => d.sufficientData && d.score !== null);

  let companyScore: number | null = null;
  if (scoredDepts.length > 0) {
    let totalWeight = 0;
    let weightedSum = 0;
    for (const dept of scoredDepts) {
      const vol = getWindowTaskVolume(db, dept.workspaceId, windowDays);
      const w = Math.max(vol, 1); // minimum weight 1 so zero-task depts still contribute
      totalWeight += w;
      weightedSum += dept.score! * w;
    }
    companyScore = totalWeight > 0
      ? Math.round((weightedSum / totalWeight) * 100) / 100
      : null;
  }

  // Worst-trending: compute delta between current and previous window
  const worstTrending: WorstTrendingEntry[] = computeWorstTrending(
    db,
    realWorkspaces,
    windowDays,
    weights,
  );

  // PRD 2.14: Company-level LSS aggregate
  const companyLss = computeCompanyLss(db, departments, realWorkspaces, windowDays);

  return {
    score: companyScore,
    grade: companyScore !== null ? scoreToGrade(companyScore) : null,
    departments,
    worstTrending,
    generatedAt: new Date().toISOString(),
    lss: companyLss,
  };
}

/**
 * Aggregate per-dept LSS metrics to the company level.
 * defectRate/reworkRate: task-count-weighted average across depts with data.
 * staleLoopsKilled: plain sum.
 * tokensPerTask: averaged across all real depts from task_activities.metadata.
 */
function computeCompanyLss(
  db: Database.Database,
  departments: DepartmentGrade[],
  workspaces: WorkspaceRow[],
  windowDays: number,
): LssCompanyMetrics {
  // Aggregate stale loops (always available)
  const totalStaleLoops = departments.reduce(
    (sum, d) => sum + (d.lss?.staleLoopsKilled ?? 0),
    0,
  );

  // Task-count-weighted defect rate and rework rate
  let totalDefectWeight = 0;
  let weightedDefectSum = 0;
  let totalReworkWeight = 0;
  let weightedReworkSum = 0;

  for (const dept of departments) {
    if (!dept.lss) continue;
    const { defectRate, reworkRate } = dept.lss;

    if (defectRate.score !== null && defectRate.sampleSize > 0) {
      totalDefectWeight += defectRate.sampleSize;
      weightedDefectSum += defectRate.score * defectRate.sampleSize;
    }
    if (reworkRate.score !== null && reworkRate.sampleSize > 0) {
      totalReworkWeight += reworkRate.sampleSize;
      weightedReworkSum += reworkRate.score * reworkRate.sampleSize;
    }
  }

  const companyDefectRate = totalDefectWeight > 0
    ? Math.round(weightedDefectSum / totalDefectWeight)
    : null;
  const companyReworkRate = totalReworkWeight > 0
    ? Math.round(weightedReworkSum / totalReworkWeight)
    : null;

  // Company-level tokensPerTask: aggregate token metadata across all real workspaces
  const allTokenCounts: number[] = [];
  for (const ws of workspaces) {
    const probe = computeTokensPerTask(db, ws.id, windowDays);
    if (probe.value !== null) {
      allTokenCounts.push(probe.value);
    }
  }

  const tokensPerTask = allTokenCounts.length > 0
    ? Math.round(allTokenCounts.reduce((s, n) => s + n, 0) / allTokenCounts.length)
    : null;
  const tokensPerTaskDetail = tokensPerTask !== null
    ? `Avg ${tokensPerTask} tokens/completed-task (${allTokenCounts.length} dept(s) with token metadata)`
    : 'No per-task token data captured (bridge does not emit token counts)';

  return {
    defectRate: companyDefectRate,
    reworkRate: companyReworkRate,
    staleLoopsKilled: totalStaleLoops,
    tokensPerTask,
    tokensPerTaskDetail,
  };
}

// ---------------------------------------------------------------------------
// Trend computation
// ---------------------------------------------------------------------------

/**
 * Compute per-dept delta (current window - previous window).
 * Returns up to 3 depts with the most negative delta that have sufficient data.
 */
function computeWorstTrending(
  db: Database.Database,
  workspaces: WorkspaceRow[],
  windowDays: number,
  weights?: Record<GradeInputKey, number>,
): WorstTrendingEntry[] {
  const entries: Array<{ ws: WorkspaceRow; delta: number; failingInput: GradeInputKey; detail: string }> = [];

  for (const ws of workspaces) {
    const current = computeDepartmentGrade(db, ws, windowDays, weights);
    if (!current.sufficientData || current.score === null) continue;

    // Previous window: shift start back by windowDays
    // We approximate by computing the score over the 2x window and comparing
    // Use a simplified approach: re-compute with time-shifted queries
    const prev = computeDepartmentGradePrevWindow(db, ws, windowDays, weights);
    if (prev === null) continue;

    const delta = current.score - prev;

    // Find the lowest-scoring input as the failing input
    const presentInputs = (Object.keys(current.inputs) as GradeInputKey[])
      .filter((k) => current.inputs[k].score !== null)
      .sort((a, b) => current.inputs[a].score! - current.inputs[b].score!);

    if (presentInputs.length === 0) continue;

    const failingInput = presentInputs[0];
    entries.push({
      ws,
      delta,
      failingInput,
      detail: current.inputs[failingInput].detail,
    });
  }

  return entries
    .sort((a, b) => a.delta - b.delta) // most negative first
    .slice(0, 3)
    .map((e) => ({
      slug: e.ws.slug,
      name: e.ws.name,
      failingInput: e.failingInput,
      detail: e.detail,
      delta: Math.round(e.delta * 100) / 100,
    }));
}

/**
 * Compute a department's score for the PREVIOUS rolling window
 * (days windowDays..2*windowDays ago) for trend comparison.
 * Returns null if insufficient data in the prior window.
 */
function computeDepartmentGradePrevWindow(
  db: Database.Database,
  ws: WorkspaceRow,
  windowDays: number,
  weights?: Record<GradeInputKey, number>,
): number | null {
  const w = weights || DEFAULT_INPUT_WEIGHTS;

  const inputs: Record<GradeInputKey, InputScore> = {
    throughput: computeThroughputPrev(db, ws.id, windowDays),
    qcPassRate: computeQcPassRatePrev(db, ws.id, windowDays),
    sopCoverage: computeSopCoveragePrev(db, ws.id, windowDays),
    kpiAttainment: { key: 'kpiAttainment', score: null, sampleSize: 0, detail: 'trend N/A' },
  };

  const presentKeys = (Object.keys(inputs) as GradeInputKey[]).filter(
    (k) => inputs[k].score !== null
  );
  if (presentKeys.length < GRADING_THRESHOLDS.MIN_GRADED_INPUTS) return null;

  const totalWeight = presentKeys.reduce((s, k) => s + w[k], 0);
  const weightedSum = presentKeys.reduce((s, k) => s + inputs[k].score! * w[k], 0);
  return Math.round((weightedSum / totalWeight) * 100) / 100;
}

function computeThroughputPrev(db: Database.Database, workspaceId: string, windowDays: number): InputScore {
  const row = db.prepare(
    `SELECT
       COUNT(*) AS created,
       SUM(CASE WHEN status = 'done'
                 AND julianday('now') - julianday(COALESCE(completed_at, updated_at)) > ?
                 AND julianday('now') - julianday(COALESCE(completed_at, updated_at)) <= ?
                THEN 1 ELSE 0 END) AS completed
     FROM tasks
     WHERE workspace_id = ?
       AND julianday('now') - julianday(created_at) > ?
       AND julianday('now') - julianday(created_at) <= ?`
  ).get(windowDays, windowDays * 2, workspaceId, windowDays, windowDays * 2) as
    | { created: number; completed: number }
    | undefined;

  const created = row?.created ?? 0;
  const completed = row?.completed ?? 0;
  const total = created + completed;

  if (total < GRADING_THRESHOLDS.MIN_TASKS_FOR_THROUGHPUT) {
    return { key: 'throughput', score: null, sampleSize: total, detail: 'prev window insufficient' };
  }
  const denom = Math.max(created, completed);
  const score = Math.min(100, Math.round((completed / denom) * 100));
  return { key: 'throughput', score, sampleSize: total, detail: '' };
}

function computeQcPassRatePrev(db: Database.Database, workspaceId: string, windowDays: number): InputScore {
  const row = db.prepare(
    `SELECT COUNT(*) AS total, SUM(passed) AS passes
     FROM task_qc_results
     WHERE workspace_id = ?
       AND scoring_path = 'llm'
       AND julianday('now') - julianday(scored_at) > ?
       AND julianday('now') - julianday(scored_at) <= ?`
  ).get(workspaceId, windowDays, windowDays * 2) as { total: number; passes: number } | undefined;

  const total = row?.total ?? 0;
  if (total < GRADING_THRESHOLDS.MIN_QC_RESULTS) {
    return { key: 'qcPassRate', score: null, sampleSize: total, detail: 'prev window insufficient' };
  }
  const score = Math.round(((row?.passes ?? 0) / total) * 100);
  return { key: 'qcPassRate', score, sampleSize: total, detail: '' };
}

function computeSopCoveragePrev(db: Database.Database, workspaceId: string, windowDays: number): InputScore {
  const row = db.prepare(
    `SELECT COUNT(DISTINCT e.task_id) AS dispatched,
            SUM(CASE WHEN t.sop_id IS NOT NULL THEN 1 ELSE 0 END) AS with_sop
     FROM events e
     JOIN tasks t ON t.id = e.task_id
     WHERE e.type = 'task_dispatched'
       AND t.workspace_id = ?
       AND julianday('now') - julianday(e.created_at) > ?
       AND julianday('now') - julianday(e.created_at) <= ?`
  ).get(workspaceId, windowDays, windowDays * 2) as { dispatched: number; with_sop: number } | undefined;

  const dispatched = row?.dispatched ?? 0;
  if (dispatched < GRADING_THRESHOLDS.MIN_DISPATCHED) {
    return { key: 'sopCoverage', score: null, sampleSize: dispatched, detail: 'prev window insufficient' };
  }
  const score = Math.round(((row?.with_sop ?? 0) / dispatched) * 100);
  return { key: 'sopCoverage', score, sampleSize: dispatched, detail: '' };
}
