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
 */

import { getDb } from '@/lib/db';
import { canonicalTrioRole } from '@/lib/db/migrations';

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
