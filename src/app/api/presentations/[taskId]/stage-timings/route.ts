/**
 * GET /api/presentations/[taskId]/stage-timings — FIX 53 (MASTER Part 8,
 * [R5A §E, §H6]) — per-task stage-timing history.
 *
 * The POST side (/api/presentations/stage-timings) lands the engine's
 * phase_exit / run_summary rows from working/telemetry/stage-timings.jsonl
 * into presentation_stage_timings. This GET is the READ half of the fix: it
 * answers "what did this deck run actually cost in wall time?" for ONE task
 * id, so the stepper and the parent card can show non-null per-phase
 * elapsed_s and the run's total wall.
 *
 * Task→run resolution (the rows are keyed by run_id; a task id is not):
 *   1. rows whose task_id column equals the requested task (the ingest route
 *      stamps task_id when the caller supplies it — FIX 53's linkage), and
 *   2. rows whose run_id appears as a CHILD of this task: the deck engine
 *      posts every phase card with parent_task_id = <deck parent id> and its
 *      Session: provenance is the run id, so the child set's session key IS
 *      the run id (WI-15b), and
 *   3. rows whose run_id equals the requested task's own external session —
 *      the parent ingest stores the run id in requester_session_key/
 *      external provenance when the producer supplies one.
 *
 * Whatever path resolves, the response is company-scoped exactly like
 * /api/presentations/children and /api/presentations/[taskId]/phases: a task
 * outside the box's active company scope is 404, never "exists but not
 * yours" (boardWhereClause convention).
 *
 * Query surface:
 *   ?limit=N   max rows per event kind (default 200, cap 1000)
 *   ?event=phase_exit|run_summary   filter to one event kind
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveActiveCompanyId } from '@/lib/company';
import { boardWhereClause } from '@/lib/workspaces/board-query';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Per-run child session resolution: children carry `Session: <run id>`. */
function childSessionKeys(db: ReturnType<typeof getDb>, taskId: string): string[] {
  // WI-15b child cards: the engine posts each phase card through ingest with
  // external_session_id = run id, and createTaskCore embeds the provenance
  // ("Session: <run id>") into the task's event/description text. The child
  // row's requester_session_key is the durable place the session key lands
  // when the producer supplies one (normalizeRequesterSessionKey passes a
  // bare run id through unchanged). Fall back to the provenance text marker
  // for rows predating the session-key stamp.
  const fromColumn = (
    db
      .prepare(
        `SELECT DISTINCT requester_session_key FROM tasks
          WHERE parent_task_id = ? AND requester_session_key IS NOT NULL`,
      )
      .all(taskId) as Array<{ requester_session_key: string | null }>
  )
    .map((r) => r.requester_session_key)
    .filter((v): v is string => !!v);

  // Text-marker arm: pull the `Session: <id>` token out of the child rows'
  // description (createTaskCore embeds the ingest provenance line there).
  // Bounded by parent_task_id so the scan is per-run.
  const markers: string[] = [];
  const childTexts = (
    db
      .prepare(
        `SELECT description FROM tasks
          WHERE parent_task_id = ? AND description IS NOT NULL LIMIT 100`,
      )
      .all(taskId) as Array<{ description: string | null }>
  ).filter((c) => !!c.description);
  for (const child of childTexts) {
    const match = /Session: ([^\n\r]+)/.exec(child.description ?? '');
    if (match) markers.push(match[1].trim());
  }

  return Array.from(new Set([...fromColumn, ...markers]));
}

function stageTimingsColumns(db: ReturnType<typeof getDb>): Set<string> {
  return new Set(
    (db.prepare('PRAGMA table_info(presentation_stage_timings)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: { taskId: string } },
) {
  try {
    const { taskId } = params;
    const db = getDb();

    // ── Company scope (boardWhereClause convention, mirrors children/phases) ──
    const activeCompanyId = resolveActiveCompanyId(db);
    const scope = boardWhereClause(activeCompanyId);
    const scopedWorkspaceIds = (
      db.prepare(`SELECT w.id FROM workspaces w ${scope.sql}`).all(...scope.params) as {
        id: string;
      }[]
    ).map((w) => w.id);
    const scopeIdList =
      scopedWorkspaceIds.length > 0 ? scopedWorkspaceIds : ['__no_workspace__'];
    const scopePlaceholders = scopeIdList.map(() => '?').join(',');

    const task = db
      .prepare(
        `SELECT id, status FROM tasks
          WHERE id = ? AND (workspace_id IS NULL OR workspace_id IN (${scopePlaceholders}))`,
      )
      .get(taskId, ...scopeIdList) as { id: string; status: string } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Query knobs (defensive parse — bad input degrades to defaults, not 500).
    const url = new URL(request.url);
    const eventFilter = url.searchParams.get('event');
    const event = eventFilter === 'phase_exit' || eventFilter === 'run_summary' ? eventFilter : null;
    const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;

    // ── Resolve the run_ids that belong to this task ─────────────────────────
    const columns = stageTimingsColumns(db);
    const hasTaskIdColumn = columns.has('task_id');
    const runIds = new Set<string>();
    const directRows: Record<string, unknown>[] = [];

    if (columns.size > 0) {
      // Arm 1: rows stamped with this task id directly (FIX 53 linkage).
      if (hasTaskIdColumn) {
        const direct = db
          .prepare(
            `SELECT * FROM presentation_stage_timings WHERE task_id = ? ORDER BY created_at ASC`,
          )
          .all(taskId) as Record<string, unknown>[];
        directRows.push(...direct);
        for (const row of direct) {
          if (typeof row.run_id === 'string' && row.run_id) runIds.add(row.run_id);
        }
      }

      // Arm 2: run ids proven via this task's children (WI-15b session keys).
      for (const runId of childSessionKeys(db, taskId)) {
        if (runId) runIds.add(runId);
      }

      // Arm 3: the task's own session key IS a run id (parent-card ingest).
      const ownSession = db
        .prepare('SELECT requester_session_key FROM tasks WHERE id = ?')
        .get(taskId) as { requester_session_key: string | null } | undefined;
      if (ownSession?.requester_session_key) {
        runIds.add(ownSession.requester_session_key);
      }
    }

    const runIdList = Array.from(runIds);
    const runPlaceholders = runIdList.map(() => '?').join(',');
    const eventSql = event ? 'event = ?' : "event IN ('phase_exit','run_summary')";
    const eventParams: string[] = event ? [event] : [];

    const byRun =
      runIdList.length > 0
        ? (
            db
              .prepare(
                `SELECT * FROM presentation_stage_timings
                  WHERE ${eventSql} AND run_id IN (${runPlaceholders})
                  ORDER BY created_at ASC LIMIT ?`,
              )
              .all(...eventParams, ...runIdList, limit) as Record<string, unknown>[]
          )
        : [];

    const rows = [...directRows, ...byRun]
      .filter((row) => (event ? row.event === event : true))
      // Dedupe: arm 1 and the byRun query can both surface the same row.
      .filter(
        (row, i, arr) => arr.findIndex((r) => r.id === row.id) === i,
      )
      .slice(0, limit);

    // ── Shape the per-task summary the stepper/card consume ─────────────────
    const phaseRows = rows.filter((r) => r.event === 'phase_exit');
    const summaryRows = rows.filter((r) => r.event === 'run_summary');
    const totalWallS = summaryRows.reduce(
      (max, r) => Math.max(max, typeof r.total_wall_s === 'number' ? r.total_wall_s : 0),
      0,
    );
    const totalDurationS = phaseRows.reduce(
      (sum, r) => sum + (typeof r.duration_s === 'number' ? r.duration_s : 0),
      0,
    );
    const errorClasses = Array.from(
      new Set(
        phaseRows
          .map((r) => r.error_class)
          .filter((v): v is string => typeof v === 'string' && v.length > 0),
      ),
    );

    return NextResponse.json({
      task_id: taskId,
      run_ids: runIdList,
      counts: { phase_exits: phaseRows.length, run_summaries: summaryRows.length },
      totals: { wall_s: totalWallS || null, duration_s: totalDurationS || null },
      error_classes: errorClasses,
      rows: rows.map((r) => ({
        id: r.id,
        run_id: r.run_id,
        event: r.event,
        phase_id: r.phase_id,
        wave: r.wave,
        model_used: r.model_used,
        started_at: r.started_at,
        ended_at: r.ended_at,
        duration_s: r.duration_s,
        status: r.status,
        return_code: r.return_code,
        error_class: r.error_class,
        total_wall_s: r.total_wall_s,
        phase_count: r.phase_count,
        slowest_3: r.slowest_3,
        created_at: r.created_at,
      })),
    });
  } catch (error) {
    console.error('[FIX53] GET /api/presentations/[taskId]/stage-timings error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
