import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/performance
 *
 * Aggregate performance metrics across the whole company — task counts,
 * average completion time, agent utilization, department workload, trend
 * buckets, bottlenecks, and persona coverage.
 *
 * Powers the CEODashboard trends / bottlenecks / persona-coverage cards.
 */
export async function GET() {
  try {
    const db = getDb();

    // ── Task status counts ──────────────────────────────────────────────
    const statusRows = db
      .prepare(`SELECT status, COUNT(*) AS c FROM tasks GROUP BY status`)
      .all() as { status: string; c: number }[];

    const counts: Record<string, number> = {
      total: 0,
      backlog: 0,
      in_progress: 0,
      review: 0,
      blocked: 0,
      done: 0,
    };
    for (const row of statusRows) {
      counts.total += row.c;
      if (row.status === 'in_progress') counts.in_progress += row.c;
      else if (row.status === 'blocked') counts.blocked += row.c;
      else if (row.status === 'done') counts.done += row.c;
      else if (row.status === 'review' || row.status === 'testing') counts.review += row.c;
      else counts.backlog += row.c;
    }

    // ── Avg completion time ─────────────────────────────────────────────
    // completed_at is set by trigger on transition to 'done'. For older
    // databases that never ran the trigger, COALESCE to updated_at.
    const avgRow = db
      .prepare(
        `SELECT
          AVG((julianday(COALESCE(completed_at, updated_at)) - julianday(created_at)) * 86400.0) AS avg_seconds,
          COUNT(*) AS n
         FROM tasks
         WHERE status = 'done'`
      )
      .get() as { avg_seconds: number | null; n: number };
    const avgCompletionSeconds = avgRow.avg_seconds ?? 0;
    const avgCompletionHours = avgCompletionSeconds / 3600;

    // ── Agent utilization ───────────────────────────────────────────────
    const agentCountRow = db
      .prepare(`SELECT COUNT(*) AS c FROM agents`)
      .get() as { c: number };
    const totalAgents = agentCountRow.c;

    const activeAgentRow = db
      .prepare(
        `SELECT COUNT(DISTINCT assigned_agent_id) AS c
         FROM tasks
         WHERE assigned_agent_id IS NOT NULL
           AND status IN ('in_progress','review','blocked')`
      )
      .get() as { c: number };
    const activeAgents = activeAgentRow.c;
    const agentUtilization = totalAgents > 0 ? activeAgents / totalAgents : 0;

    // ── Department workload distribution ────────────────────────────────
    const deptRows = db
      .prepare(
        `SELECT
          COALESCE(w.id, t.workspace_id, 'unknown') AS workspace_id,
          COALESCE(w.name, 'Unassigned') AS workspace_name,
          COALESCE(w.slug, 'unknown') AS slug,
          COUNT(t.id) AS total,
          SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
          SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
         FROM tasks t
         LEFT JOIN workspaces w ON w.id = t.workspace_id
         GROUP BY workspace_id, workspace_name, slug
         ORDER BY total DESC`
      )
      .all() as Array<{
        workspace_id: string;
        workspace_name: string;
        slug: string;
        total: number;
        done: number;
        in_progress: number;
        blocked: number;
      }>;

    const departments = deptRows.map((d) => ({
      workspace_id: d.workspace_id,
      workspace_name: d.workspace_name,
      slug: d.slug,
      total: d.total,
      done: d.done,
      in_progress: d.in_progress,
      blocked: d.blocked,
      stalled_ratio: d.total > 0 ? d.blocked / d.total : 0,
    }));

    // ── Trend buckets (created vs completed in last 7/30/90 days) ───────
    const buildBucket = (days: number) => {
      const created = db
        .prepare(
          `SELECT COUNT(*) AS c FROM tasks
           WHERE julianday('now') - julianday(created_at) <= ?`
        )
        .get(days) as { c: number };
      const completed = db
        .prepare(
          `SELECT COUNT(*) AS c FROM tasks
           WHERE status = 'done'
             AND julianday('now') - julianday(COALESCE(completed_at, updated_at)) <= ?`
        )
        .get(days) as { c: number };
      return { created: created.c, completed: completed.c, window_days: days };
    };

    const trends = {
      last_7d: buildBucket(7),
      last_30d: buildBucket(30),
      last_90d: buildBucket(90),
    };

    // Daily series for the past 14 days (charting source).
    const dailySeries = db
      .prepare(
        `SELECT date(created_at) AS day, COUNT(*) AS created
         FROM tasks
         WHERE julianday('now') - julianday(created_at) <= 14
         GROUP BY day
         ORDER BY day ASC`
      )
      .all() as { day: string; created: number }[];

    const dailyCompletedSeries = db
      .prepare(
        `SELECT date(COALESCE(completed_at, updated_at)) AS day, COUNT(*) AS completed
         FROM tasks
         WHERE status = 'done'
           AND julianday('now') - julianday(COALESCE(completed_at, updated_at)) <= 14
         GROUP BY day
         ORDER BY day ASC`
      )
      .all() as { day: string; completed: number }[];

    // Merge into one array of { day, created, completed } points.
    const seriesByDay = new Map<string, { day: string; created: number; completed: number }>();
    for (const row of dailySeries) {
      seriesByDay.set(row.day, { day: row.day, created: row.created, completed: 0 });
    }
    for (const row of dailyCompletedSeries) {
      const existing = seriesByDay.get(row.day);
      if (existing) existing.completed = row.completed;
      else seriesByDay.set(row.day, { day: row.day, created: 0, completed: row.completed });
    }
    const trendSeries = Array.from(seriesByDay.values()).sort((a, b) =>
      a.day < b.day ? -1 : a.day > b.day ? 1 : 0
    );

    // ── Bottleneck candidates ───────────────────────────────────────────
    const bottlenecks = departments
      .filter((d) => d.total >= 3 && d.stalled_ratio > 0.4)
      .sort((a, b) => b.stalled_ratio - a.stalled_ratio)
      .slice(0, 3)
      .map((d) => ({
        workspace_id: d.workspace_id,
        workspace_name: d.workspace_name,
        slug: d.slug,
        total: d.total,
        blocked: d.blocked,
        stalled_ratio: d.stalled_ratio,
        reason: `${Math.round(d.stalled_ratio * 100)}% of tasks blocked or stalled`,
      }));

    // ── Persona coverage % ──────────────────────────────────────────────
    const personaRow = db
      .prepare(
        `SELECT
           SUM(CASE WHEN persona_id IS NOT NULL AND persona_id != '' THEN 1 ELSE 0 END) AS covered,
           COUNT(*) AS total
         FROM tasks`
      )
      .get() as { covered: number; total: number };
    const personaCoverage = personaRow.total > 0 ? personaRow.covered / personaRow.total : 0;

    return NextResponse.json({
      counts,
      avg_completion: {
        seconds: avgCompletionSeconds,
        hours: avgCompletionHours,
        n: avgRow.n,
      },
      agent_utilization: {
        active: activeAgents,
        total: totalAgents,
        ratio: agentUtilization,
      },
      departments,
      trends,
      trend_series: trendSeries,
      bottlenecks,
      persona_coverage: {
        covered: personaRow.covered,
        total: personaRow.total,
        ratio: personaCoverage,
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/performance] failed:', err);
    return NextResponse.json(
      { error: 'Failed to compute performance metrics' },
      { status: 500 }
    );
  }
}
