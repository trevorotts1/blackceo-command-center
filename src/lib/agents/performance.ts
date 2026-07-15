/**
 * U58 (Skill 6 Blended-Persona Kanban v2, Stage 2 / exec-summary item 9) —
 * Individual-agent performance surface.
 *
 * The "Agents" tab has pointed at a dead route since it was built (see the
 * `handleTabClick` fix in src/app/ceo-board/page.tsx) because no per-agent
 * performance surface existed. This module is the read-only data layer for
 * that surface: it JOINs `tasks` x `task_qc_results` (this repo's QC-results
 * table — there is no table literally named `qc_reviews`; `task_qc_results`
 * is the one PRD 2.10 / migration 068 already ships, and is what "qc_reviews"
 * in the unit brief refers to) to compute per-agent metrics, buckets a weekly
 * trend series, and filters the department-trio agents (qc / research /
 * devils-advocate) out of the performance board — they are internal tooling
 * seeded per-department (migration 065/092), not real performers.
 *
 * EVERYTHING here is computed on-read from existing rows (tasks.completed_at,
 * task_qc_results.score/passed). No new table, no migration — additive-only,
 * matching the rest of this wave's "compute on read" units (see grading.ts /
 * resolve-department.ts for the same pattern scoped to departments instead of
 * agents).
 *
 * Does NOT depend on U59 — the trio exclusion here uses the trio's EXISTING
 * canonical definition (TRIO_ROLE_TYPES / canonicalTrioRole in
 * @/lib/db/migrations, the same import qc-scorer.ts's resolveTrioAgents()
 * already uses), not anything U59 introduces.
 *
 * --- U58 QC fix-loop addition (getAgentGrade) --------------------------
 * `getAgentPerformance` above is the pure, ungated tasks x task_qc_results
 * join primitive — kept exactly as originally shipped (all-time, no sample
 * gate) because it is a useful low-level building block AND its existing
 * tests deliberately exercise it at n=1 to prove the "latest QC attempt
 * wins" tie-break logic in isolation.
 *
 * `getAgentGrade` below is the NEW windowed, gated, DepartmentGrade-shaped
 * surface the endpoint actually serves. It scopes the same four PRD inputs
 * `src/lib/grading.ts` already computes at department level (throughput /
 * qcPassRate / sopCoverage / kpiAttainment) down to one agent's own tasks,
 * using the IDENTICAL formulas, gates (GRADING_THRESHOLDS), and weights
 * (DEFAULT_INPUT_WEIGHTS) grading.ts exports — just re-scoped from
 * `workspace_id` to `tasks.assigned_agent_id` (grading.ts has no
 * agent-scoped variant to import, so the scoped SQL is re-stated here
 * rather than refactoring the department module's private query
 * functions). kpiAttainment has no agent-level KPI source (spec (a)) and
 * always renders "Insufficient data" rather than approximating one.
 *
 * blockedCount/blockedTasks/velocity reuse
 * `computeDepartmentOperationalStats` from @/lib/ceo-board/ verbatim — that
 * function is generic over any task list (it does not filter by workspace
 * itself, the caller pre-scopes the rows), so scoping it to one agent's
 * tasks instead of one department's tasks needs no new code, and gets the
 * exact same honesty discipline (blockedCount always a real integer,
 * velocity null only when the agent has zero tasks ever) for free.
 */

import { getDb } from '@/lib/db';
import { canonicalTrioRole } from '@/lib/db/migrations';
import {
  GRADING_THRESHOLDS,
  DEFAULT_INPUT_WEIGHTS,
  scoreToGrade,
  type Grade,
  type GradeInputKey,
  type InputScore,
} from '@/lib/grading';
import {
  computeDepartmentOperationalStats,
  type OperationalTaskInput,
  type BlockedTaskSummary,
} from '@/lib/ceo-board/department-operational-stats';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  avatarEmoji: string;
  status: string;
}

export interface WeeklyTrendPoint {
  /** ISO date (UTC) of the Monday that starts this bucket's week, e.g. '2026-07-13'. */
  weekStart: string;
  completedCount: number;
  /** Average LLM-graded QC score for tasks completed in this week; null when none were QC'd. */
  avgQcScore: number | null;
}

export interface AgentPerformance {
  agentId: string;
  agentName: string;
  agentRole: string;
  /** Total tasks this agent has completed (status='done'), all time. */
  completedCount: number;
  /** Average LLM-graded QC score across this agent's QC'd completed tasks; null = never QC'd. */
  avgQcScore: number | null;
  /** How many completed tasks actually carry an LLM-graded QC result. */
  qcSampleSize: number;
  /** Percent (0-100) of QC'd tasks that passed the gate; null = never QC'd. */
  passRate: number | null;
  /** completedCount / number of distinct weeks in `trend` — 0 when there is no completed work. */
  throughputPerWeek: number;
  /** Ascending by weekStart; only weeks with at least one completion are included. */
  trend: WeeklyTrendPoint[];
}

// ---------------------------------------------------------------------------
// Trio exclusion (D2/D5-adjacent, but this is the plain department-trio
// concept, not the persona blend invariant — see TRIO_ROLE_TYPES).
// ---------------------------------------------------------------------------

/**
 * True when `roleType` is one of the three department-trio internal roles
 * (qc / research / devils-advocate — see TRIO_ROLE_TYPES / TRIO_ROLE_ALIASES
 * in @/lib/db/migrations, the single canonical trio definition this repo
 * maintains, PRD 2.11 / migration 065/092). Any alias spelling (e.g. Skill
 * 23's 'deep-research') is recognised via canonicalTrioRole.
 */
export function isTrioAgent(roleType: string | null | undefined): boolean {
  return canonicalTrioRole(roleType) !== null;
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  role_type: string | null;
  avatar_emoji: string | null;
  status: string;
}

/**
 * List every agent eligible for the performance board — the department trio
 * excluded, every other agent (however specialised) included. Used by the
 * /agents index page.
 */
export function listPerformanceEligibleAgents(): AgentSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name, role, role_type, avatar_emoji, status
         FROM agents
        ORDER BY name ASC`,
    )
    .all() as AgentRow[];

  return rows
    .filter((r) => !isTrioAgent(r.role_type))
    .map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      avatarEmoji: r.avatar_emoji || '🤖',
      status: r.status,
    }));
}

// ---------------------------------------------------------------------------
// Weekly bucketing
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The UTC ISO date (YYYY-MM-DD) of the Monday that starts the ISO week
 *  containing `dateStr`. Timestamps in this DB are stored in two dialects
 *  (see sqlTime()/parseDbTime() in @/lib/db) — `new Date(dateStr)` parses
 *  both the 'T'/'Z' ISO form and the SQLite space form correctly enough for
 *  week-bucketing purposes (day-level granularity, not sub-second). */
function isoWeekStart(dateStr: string): string {
  const raw = dateStr.includes('T') || /Z|[+-]\d{2}:?\d{2}$/.test(dateStr)
    ? dateStr
    : `${dateStr.replace(' ', 'T')}Z`;
  const d = new Date(raw);
  const utcDay = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (utcDay + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMonday),
  );
  return monday.toISOString().slice(0, 10);
}

interface TrendInputRow {
  completedAt: string;
  score: number | null;
}

/** Bucket completed-task rows into ascending weekly points. Pure function —
 *  same input always yields the same output (idempotent series). */
function bucketWeekly(rows: TrendInputRow[]): WeeklyTrendPoint[] {
  const buckets = new Map<string, { count: number; scoreSum: number; scoreCount: number }>();
  for (const row of rows) {
    const weekStart = isoWeekStart(row.completedAt);
    const bucket = buckets.get(weekStart) ?? { count: 0, scoreSum: 0, scoreCount: 0 };
    bucket.count += 1;
    if (row.score !== null) {
      bucket.scoreSum += row.score;
      bucket.scoreCount += 1;
    }
    buckets.set(weekStart, bucket);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStart, bucket]) => ({
      weekStart,
      completedCount: bucket.count,
      avgQcScore: bucket.scoreCount > 0 ? round2(bucket.scoreSum / bucket.scoreCount) : null,
    }));
}

// ---------------------------------------------------------------------------
// The per-agent QC-join query
// ---------------------------------------------------------------------------

interface CompletedTaskRow {
  id: string;
  completed_at: string;
}

interface QcResultRow {
  task_id: string;
  score: number;
  passed: number;
  scored_at: string;
  attempt: number;
}

function zeroState(agentId: string, agentName: string, agentRole: string): AgentPerformance {
  return {
    agentId,
    agentName,
    agentRole,
    completedCount: 0,
    avgQcScore: null,
    qcSampleSize: 0,
    passRate: null,
    throughputPerWeek: 0,
    trend: [],
  };
}

/**
 * Compute performance metrics + a weekly trend series for one agent by
 * JOINing `tasks` (this agent's completed work, status='done') against
 * `task_qc_results` (the QC-review rows for those tasks). Everything is
 * computed on-read; nothing is persisted.
 *
 * Returns null when no agent with this id exists (the caller — the API
 * route — turns that into a 404). An agent that exists but has zero
 * completed tasks returns the honest zero-state (completedCount 0, null
 * score/pass-rate, empty trend) — never a fabricated number.
 */
export function getAgentPerformance(agentId: string): AgentPerformance | null {
  const db = getDb();

  const agent = db
    .prepare(`SELECT id, name, role FROM agents WHERE id = ?`)
    .get(agentId) as { id: string; name: string; role: string } | undefined;
  if (!agent) return null;

  const completedTasks = db
    .prepare(
      `SELECT id, completed_at
         FROM tasks
        WHERE assigned_agent_id = ?
          AND status = 'done'
          AND completed_at IS NOT NULL
        ORDER BY completed_at ASC`,
    )
    .all(agentId) as CompletedTaskRow[];

  if (completedTasks.length === 0) {
    return zeroState(agent.id, agent.name, agent.role);
  }

  const taskIds = completedTasks.map((t) => t.id);
  const placeholders = taskIds.map(() => '?').join(',');

  // LLM rows only — heuristic/no-criteria are NOT graded outcomes (PRD 2.4),
  // matching computeQcPassRate's convention in @/lib/grading.
  const qcRows = db
    .prepare(
      `SELECT task_id, score, passed, scored_at, attempt
         FROM task_qc_results
        WHERE task_id IN (${placeholders})
          AND scoring_path = 'llm'
        ORDER BY scored_at ASC, attempt ASC`,
    )
    .all(...taskIds) as QcResultRow[];

  // A task can be re-scored (qc_reroute_attempts); keep only the LATEST
  // LLM-graded verdict per task — rows are ordered ascending above, so a
  // later row for the same task_id simply overwrites the earlier one here.
  const latestByTask = new Map<string, { score: number; passed: number }>();
  for (const row of qcRows) {
    latestByTask.set(row.task_id, { score: row.score, passed: row.passed });
  }

  let scoreSum = 0;
  let scoreCount = 0;
  let passCount = 0;
  const trendInput: TrendInputRow[] = [];

  for (const task of completedTasks) {
    const qc = latestByTask.get(task.id);
    if (qc) {
      scoreSum += qc.score;
      scoreCount += 1;
      if (qc.passed) passCount += 1;
    }
    trendInput.push({ completedAt: task.completed_at, score: qc ? qc.score : null });
  }

  const trend = bucketWeekly(trendInput);
  const avgQcScore = scoreCount > 0 ? round2(scoreSum / scoreCount) : null;
  const passRate = scoreCount > 0 ? round2((passCount / scoreCount) * 100) : null;
  const throughputPerWeek = trend.length > 0 ? round2(completedTasks.length / trend.length) : 0;

  return {
    agentId: agent.id,
    agentName: agent.name,
    agentRole: agent.role,
    completedCount: completedTasks.length,
    avgQcScore,
    qcSampleSize: scoreCount,
    passRate,
    throughputPerWeek,
    trend,
  };
}

// ---------------------------------------------------------------------------
// U58 QC fix-loop — windowed, gated agent grade (mirrors DepartmentGrade)
// ---------------------------------------------------------------------------

/** Default rolling window, matching computeDepartmentGrade / computeCompanyHealth's default. */
export const DEFAULT_AGENT_WINDOW_DAYS = 30;

export interface AgentGrade {
  agentId: string;
  agentName: string;
  agentRole: string;
  /** Rolling window size actually used for this response (the `?window=` query param). */
  windowDays: number;
  /** The same four PRD inputs as DepartmentGrade (src/lib/grading.ts), scoped to this
   *  agent's own tasks. score is null (never a number) below each input's sample gate. */
  inputs: Record<GradeInputKey, InputScore>;
  /** Weighted avg over inputs WITH data; null if fewer than MIN_GRADED_INPUTS have data. */
  score: number | null;
  grade: Grade | null;
  sufficientData: boolean;
  /** completed/created within the window; null only when zero tasks were CREATED in the
   *  window (never 0%) — same convention as CompanyHealth.windowedCompletionRate. */
  windowedCompletionRate: number | null;
  /** Count of this agent's tasks currently status='blocked' — always a real integer,
   *  0 is an honest zero, never omitted. */
  blockedCount: number;
  /** The blocked tasks themselves — length always equals blockedCount (same array). */
  blockedTasks: BlockedTaskSummary[];
  /** Completed-per-week rate averaged over windowDays (KPIStatCards.tsx's Avg Velocity
   *  formula, scoped to this agent) — distinct from the throughput INPUT above (that's a
   *  %, this is a rate/week). Null only when the agent has zero tasks at all. */
  velocity: number | null;
  /** All-time completed count. A plain honest integer (not a derived rate), so unlike the
   *  gated inputs above it needs no sample gate — 0 is exactly as honest as any other value. */
  completedCount: number;
  /** All-time weekly trend series (unchanged from getAgentPerformance). */
  trend: WeeklyTrendPoint[];
}

interface AgentIdentityRow {
  id: string;
  name: string;
  role: string;
}

interface AgentWindowTaskCounts {
  created: number;
  completed: number;
}

function getAgentWindowedTaskCounts(
  db: ReturnType<typeof getDb>,
  agentId: string,
  windowDays: number,
): AgentWindowTaskCounts {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS created,
         SUM(CASE WHEN status = 'done'
                   AND julianday('now') - julianday(COALESCE(completed_at, updated_at)) <= ?
                  THEN 1 ELSE 0 END) AS completed
       FROM tasks
       WHERE assigned_agent_id = ?
         AND julianday('now') - julianday(created_at) <= ?`,
    )
    .get(windowDays, agentId, windowDays) as AgentWindowTaskCounts | undefined;

  return { created: row?.created ?? 0, completed: row?.completed ?? 0 };
}

/** Mirrors grading.ts's computeThroughput, scoped to one agent's tasks instead of a workspace. */
function computeAgentThroughputInput(counts: AgentWindowTaskCounts): InputScore {
  const { created, completed } = counts;

  if (created < GRADING_THRESHOLDS.MIN_TASKS_FOR_THROUGHPUT) {
    return {
      key: 'throughput',
      score: null,
      sampleSize: created,
      detail: `Insufficient task data (${created} tasks created, need ${GRADING_THRESHOLDS.MIN_TASKS_FOR_THROUGHPUT}+)`,
    };
  }

  // Denominator: max(created, completed) prevents > 100% when clearing backlog.
  const denom = Math.max(created, completed);
  const score = Math.min(100, Math.round((completed / denom) * 100));
  return {
    key: 'throughput',
    score,
    sampleSize: created,
    detail: `${completed} completed of ${created} created (${score}%)`,
  };
}

/** Mirrors grading.ts's computeQcPassRate, scoped via the J.0.4 tasks x task_qc_results join. */
function computeAgentQcPassRateInput(
  db: ReturnType<typeof getDb>,
  agentId: string,
  windowDays: number,
): InputScore {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(tqr.passed) AS passes
       FROM task_qc_results tqr
       JOIN tasks t ON t.id = tqr.task_id
       WHERE t.assigned_agent_id = ?
         AND tqr.scoring_path = 'llm'
         AND julianday('now') - julianday(tqr.scored_at) <= ?`,
    )
    .get(agentId, windowDays) as { total: number; passes: number } | undefined;

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

/** Mirrors grading.ts's computeSopCoverage, scoped to tasks dispatched to this agent. */
function computeAgentSopCoverageInput(
  db: ReturnType<typeof getDb>,
  agentId: string,
  windowDays: number,
): InputScore {
  const row = db
    .prepare(
      `SELECT
         COUNT(DISTINCT e.task_id) AS dispatched,
         SUM(CASE WHEN t.sop_id IS NOT NULL THEN 1 ELSE 0 END) AS with_sop
       FROM events e
       JOIN tasks t ON t.id = e.task_id
       WHERE e.type = 'task_dispatched'
         AND t.assigned_agent_id = ?
         AND julianday('now') - julianday(e.created_at) <= ?`,
    )
    .get(agentId, windowDays) as { dispatched: number; with_sop: number } | undefined;

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

/** Spec (a): agent-level KPI attainment has no real source yet — never approximated
 *  from department-level kpi_snapshots (those are department-scoped, not per-agent). */
function agentKpiAttainmentInput(): InputScore {
  return {
    key: 'kpiAttainment',
    score: null,
    sampleSize: 0,
    detail: 'No agent-level KPI targets tracked yet — kpi_snapshots only tracks department-level targets',
  };
}

/** Mirrors computeDepartmentGrade's combine step exactly: only inputs WITH data count
 *  toward the weighted average, and MIN_GRADED_INPUTS must have data for a score at all. */
function combineAgentGradeInputs(
  inputs: Record<GradeInputKey, InputScore>,
): { score: number | null; grade: Grade | null; sufficientData: boolean } {
  const presentKeys = (Object.keys(inputs) as GradeInputKey[]).filter(
    (k) => inputs[k].score !== null,
  );
  const sufficientData = presentKeys.length >= GRADING_THRESHOLDS.MIN_GRADED_INPUTS;

  let score: number | null = null;
  if (sufficientData) {
    const totalWeight = presentKeys.reduce((s, k) => s + DEFAULT_INPUT_WEIGHTS[k], 0);
    const weightedSum = presentKeys.reduce(
      (s, k) => s + inputs[k].score! * DEFAULT_INPUT_WEIGHTS[k],
      0,
    );
    score = Math.round((weightedSum / totalWeight) * 100) / 100;
  }

  return { score, grade: score !== null ? scoreToGrade(score) : null, sufficientData };
}

/** Loads this agent's own tasks in the exact shape computeDepartmentOperationalStats needs. */
function loadAgentOperationalTasks(
  db: ReturnType<typeof getDb>,
  agentId: string,
): OperationalTaskInput[] {
  return db
    .prepare(
      `SELECT id, title, status, block_reason, block_needs, updated_at, completed_at, created_at
         FROM tasks
        WHERE assigned_agent_id = ?`,
    )
    .all(agentId) as OperationalTaskInput[];
}

/**
 * Compute one agent's windowed, gated grade — the endpoint's primary payload.
 * Returns null when no agent with this id exists (the caller — the API route —
 * turns that into a 404), matching getAgentPerformance's existence convention.
 */
export function getAgentGrade(
  agentId: string,
  windowDays: number = DEFAULT_AGENT_WINDOW_DAYS,
): AgentGrade | null {
  const db = getDb();

  const agent = db
    .prepare(`SELECT id, name, role FROM agents WHERE id = ?`)
    .get(agentId) as AgentIdentityRow | undefined;
  if (!agent) return null;

  // completedCount + trend are all-time (unwindowed) — reuse the existing, already-tested
  // pure join primitive rather than recomputing the same numbers a second way.
  const perf = getAgentPerformance(agentId)!;

  const counts = getAgentWindowedTaskCounts(db, agentId, windowDays);
  const inputs: Record<GradeInputKey, InputScore> = {
    throughput: computeAgentThroughputInput(counts),
    qcPassRate: computeAgentQcPassRateInput(db, agentId, windowDays),
    sopCoverage: computeAgentSopCoverageInput(db, agentId, windowDays),
    kpiAttainment: agentKpiAttainmentInput(),
  };
  const { score, grade, sufficientData } = combineAgentGradeInputs(inputs);

  const windowedCompletionRate =
    counts.created > 0 ? Math.round((counts.completed / counts.created) * 100) : null;

  const opsTasks = loadAgentOperationalTasks(db, agentId);
  const ops = computeDepartmentOperationalStats(opsTasks, windowDays);

  return {
    agentId: agent.id,
    agentName: agent.name,
    agentRole: agent.role,
    windowDays,
    inputs,
    score,
    grade,
    sufficientData,
    windowedCompletionRate,
    blockedCount: ops.blockedCount,
    blockedTasks: ops.blockedTasks,
    velocity: ops.avgVelocity,
    completedCount: perf.completedCount,
    trend: perf.trend,
  };
}
