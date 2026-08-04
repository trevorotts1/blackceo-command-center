import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveActiveCompanyId } from '@/lib/company';
import { boardWhereClause } from '@/lib/workspaces/board-query';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';

export const dynamic = 'force-dynamic';

/**
 * GET /api/performance
 *
 * Aggregate performance metrics across the whole company — task counts,
 * average completion time, agent utilization, department workload, trend
 * buckets, bottlenecks, and persona coverage.
 *
 * Powers the CEO Board's trends / bottlenecks / persona-coverage cards
 * (KPIStatCards.tsx and related redesign components — the `CEODashboard`
 * component this comment used to reference was dead code, deleted in U57).
 *
 * DEFECT 1 (2026-08-04, "WANTED Woman" / wanted-woman incident): every metric
 * here used to be a BARE, UNSCOPED `COUNT(*)` / `GROUP BY` over `tasks` and
 * `agents` — no join to `workspaces`, no company filter, no dept- prefix
 * dedup. On a box carrying duplicate workspace rows for the same department
 * (`dept-marketing` AND `marketing` — see task-dedup.ts's FM-6 / MR-21 notes)
 * or a SECOND company's rows (multi-client box), this silently summed BOTH,
 * reporting e.g. 288 agents for a 36-agent, 35-department workforce.
 *
 * Fix: scope every query to the active company via the SAME
 * `resolveActiveCompanyId` + `boardWhereClause` convention `/api/workspaces`
 * and `/api/system/converge` already use (so this route can never disagree
 * with what the board itself shows), and dedup workspaces across the
 * `dept-`-prefix boundary via `canonicalDeptSlug` — mirroring
 * `dedupeCanonicalWorkspaces`' keeper-selection order (canonical-slug row
 * first, then most agents+tasks, then oldest rowid) — so a box that has not
 * yet run the merge-duplicates healing pass still reports the TRUE
 * department/agent count instead of double-counting a stray pair.
 */
export async function GET() {
  try {
    const db = getDb();

    // ── Active-company scope ────────────────────────────────────────────
    // tasks/agents carry no direct company_id — only `workspaces.company_id`
    // does — so every metric below is scoped by joining through workspaces
    // and applying the board's own WHERE clause (company + non-archived +
    // test/fixture residue exclusion). An un-branded box (no active company
    // resolvable) is NOT company-filtered, matching boardWhereClause's own
    // documented posture.
    const activeCompanyId = resolveActiveCompanyId(db);
    const scope = boardWhereClause(activeCompanyId);

    const scopedWorkspaceRows = db
      .prepare(`SELECT w.id, w.slug, w.rowid AS rowid FROM workspaces w ${scope.sql} ORDER BY w.rowid ASC`)
      .all(...scope.params) as { id: string; slug: string; rowid: number }[];

    const scopedWorkspaceIds = scopedWorkspaceRows.map((w) => w.id);
    // SQLite has no empty IN-list syntax; a sentinel that can never match a
    // real workspace id keeps every `IN (...)` query below well-formed and
    // correctly returns zero rows when the company has no live workspaces.
    const taskScopeIds = scopedWorkspaceIds.length > 0 ? scopedWorkspaceIds : ['__no_workspace__'];
    const taskScopePlaceholders = taskScopeIds.map(() => '?').join(',');

    // Dedup across the dept- prefix boundary (and any other slug variant that
    // canonicalizes to the same department, e.g. "billing" / "billing-finance"):
    // group in-scope workspaces by canonical slug and keep exactly ONE
    // workspace id per department. This is the SAME keeper-selection order
    // `dedupeCanonicalWorkspaces` (task-dedup.ts) uses for its healing merge,
    // applied here read-only so a box that has not been healed yet still
    // reports the correct count.
    const agentCountStmt = db.prepare('SELECT COUNT(*) AS c FROM agents WHERE workspace_id = ?');
    const taskCountStmt = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ?');

    const byCanonicalDept = new Map<string, typeof scopedWorkspaceRows>();
    for (const row of scopedWorkspaceRows) {
      const canon = canonicalDeptSlug(row.slug) || row.slug.toLowerCase();
      const bucket = byCanonicalDept.get(canon);
      if (bucket) bucket.push(row);
      else byCanonicalDept.set(canon, [row]);
    }

    const keeperWorkspaceIds: string[] = [];
    for (const [canon, members] of Array.from(byCanonicalDept.entries())) {
      if (members.length === 1) {
        keeperWorkspaceIds.push(members[0].id);
        continue;
      }
      const scored = members.map((m) => {
        const a = (agentCountStmt.get(m.id) as { c: number }).c;
        const t = (taskCountStmt.get(m.id) as { c: number }).c;
        return { ...m, weight: a + t, isCanonical: m.slug.toLowerCase() === canon };
      });
      scored.sort((a, b) => {
        if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1;
        if (a.weight !== b.weight) return b.weight - a.weight;
        return a.rowid - b.rowid;
      });
      keeperWorkspaceIds.push(scored[0].id);
    }
    const keeperIdList = keeperWorkspaceIds.length > 0 ? keeperWorkspaceIds : ['__no_workspace__'];
    const keeperPlaceholders = keeperIdList.map(() => '?').join(',');

    // ── Task status counts (company-scoped) ─────────────────────────────
    const statusRows = db
      .prepare(
        `SELECT status, COUNT(*) AS c FROM tasks WHERE workspace_id IN (${taskScopePlaceholders}) GROUP BY status`
      )
      .all(...taskScopeIds) as { status: string; c: number }[];

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

    // ── Avg completion time (company-scoped) ────────────────────────────
    // completed_at is set by trigger on transition to 'done'. For older
    // databases that never ran the trigger, COALESCE to updated_at.
    const avgRow = db
      .prepare(
        `SELECT
          AVG((julianday(COALESCE(completed_at, updated_at)) - julianday(created_at)) * 86400.0) AS avg_seconds,
          COUNT(*) AS n
         FROM tasks
         WHERE status = 'done' AND workspace_id IN (${taskScopePlaceholders})`
      )
      .get(...taskScopeIds) as { avg_seconds: number | null; n: number };
    const avgCompletionSeconds = avgRow.avg_seconds ?? 0;
    const avgCompletionHours = avgCompletionSeconds / 3600;

    // ── Agent utilization (company-scoped, dept-prefix deduped) ─────────
    // DEFECT 1 fix: was `SELECT COUNT(*) AS c FROM agents` — no company
    // scope, no dedup. Now counts agents only under the deduped, in-scope
    // (keeper) workspace set.
    const agentCountRow = db
      .prepare(`SELECT COUNT(*) AS c FROM agents WHERE workspace_id IN (${keeperPlaceholders})`)
      .get(...keeperIdList) as { c: number };
    const totalAgents = agentCountRow.c;

    const activeAgentRow = db
      .prepare(
        `SELECT COUNT(DISTINCT assigned_agent_id) AS c
         FROM tasks
         WHERE assigned_agent_id IS NOT NULL
           AND status IN ('in_progress','review','blocked')
           AND workspace_id IN (${taskScopePlaceholders})`
      )
      .get(...taskScopeIds) as { c: number };
    const activeAgents = activeAgentRow.c;
    const agentUtilization = totalAgents > 0 ? activeAgents / totalAgents : 0;

    // ── Department workload distribution (company-scoped) ───────────────
    // A task whose workspace_id does not resolve to any row (w.id IS NULL)
    // is kept under "Unassigned" — same posture boardWhereClause takes for
    // company_id='default'/NULL rows: never hide the box's own unattributed
    // data. A task whose workspace resolves to an OUT-OF-SCOPE row (foreign
    // company, archived, or test/fixture residue) is excluded.
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
         WHERE w.id IS NULL OR w.id IN (${taskScopePlaceholders})
         GROUP BY workspace_id, workspace_name, slug
         ORDER BY total DESC`
      )
      .all(...taskScopeIds) as Array<{
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

    // ── Trend buckets (created vs completed in last 7/30/90 days, company-scoped) ──
    const buildBucket = (days: number) => {
      const created = db
        .prepare(
          `SELECT COUNT(*) AS c FROM tasks
           WHERE julianday('now') - julianday(created_at) <= ?
             AND workspace_id IN (${taskScopePlaceholders})`
        )
        .get(days, ...taskScopeIds) as { c: number };
      const completed = db
        .prepare(
          `SELECT COUNT(*) AS c FROM tasks
           WHERE status = 'done'
             AND julianday('now') - julianday(COALESCE(completed_at, updated_at)) <= ?
             AND workspace_id IN (${taskScopePlaceholders})`
        )
        .get(days, ...taskScopeIds) as { c: number };
      return { created: created.c, completed: completed.c, window_days: days };
    };

    const trends = {
      last_7d: buildBucket(7),
      last_30d: buildBucket(30),
      last_90d: buildBucket(90),
    };

    // Daily series for the past 14 days (charting source, company-scoped).
    const dailySeries = db
      .prepare(
        `SELECT date(created_at) AS day, COUNT(*) AS created
         FROM tasks
         WHERE julianday('now') - julianday(created_at) <= 14
           AND workspace_id IN (${taskScopePlaceholders})
         GROUP BY day
         ORDER BY day ASC`
      )
      .all(...taskScopeIds) as { day: string; created: number }[];

    const dailyCompletedSeries = db
      .prepare(
        `SELECT date(COALESCE(completed_at, updated_at)) AS day, COUNT(*) AS completed
         FROM tasks
         WHERE status = 'done'
           AND julianday('now') - julianday(COALESCE(completed_at, updated_at)) <= 14
           AND workspace_id IN (${taskScopePlaceholders})
         GROUP BY day
         ORDER BY day ASC`
      )
      .all(...taskScopeIds) as { day: string; completed: number }[];

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

    // ── Bottleneck candidates (derived from the already-scoped departments) ──
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

    // ── Persona coverage % (company-scoped) ──────────────────────────────
    const personaRow = db
      .prepare(
        `SELECT
           SUM(CASE WHEN persona_id IS NOT NULL AND persona_id != '' THEN 1 ELSE 0 END) AS covered,
           COUNT(*) AS total
         FROM tasks
         WHERE workspace_id IN (${taskScopePlaceholders})`
      )
      .get(...taskScopeIds) as { covered: number; total: number };
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
