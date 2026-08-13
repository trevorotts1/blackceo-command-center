/**
 * GET /api/presentations/[taskId]/phases
 * U060 — Live phase progress for a presentation task.
 *
 * Queries task_activities and task_deliverables for the given task, reduces
 * through computePhaseProgress, and returns all seven labels in PHASE_LABELS
 * order plus job-level metadata.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  computePhaseProgress,
  PHASE_LABELS,
  PHASE_TO_LABEL,
} from '@/lib/presentation-phases';
import { resolveActiveCompanyId } from '@/lib/company';
import { boardWhereClause } from '@/lib/workspaces/board-query';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  _request: NextRequest,
  { params }: { params: { taskId: string } },
) {
  try {
    const { taskId } = params;
    const db = getDb();

    // ── Company scope (closes cross-company read) ────────────────────────
    // tasks carry no direct company_id — only workspaces.company_id does —
    // so ownership is checked by joining through workspaces and applying the
    // SAME boardWhereClause the Kanban board itself uses, via the SAME
    // resolveActiveCompanyId + boardWhereClause convention /api/performance
    // already established for task-scoped queries. A task whose workspace_id
    // is NULL is the box's own unattributed data and stays visible (matches
    // boardWhereClause's own posture); a task whose workspace resolves to an
    // OUT-OF-SCOPE workspace (foreign company / archived / residue) is
    // treated as not found, same as a task id that does not exist at all —
    // this must never distinguish "exists but not yours" from "doesn't exist".
    const activeCompanyId = resolveActiveCompanyId(db);
    const scope = boardWhereClause(activeCompanyId);
    const scopedWorkspaceIds = (
      db.prepare(`SELECT w.id FROM workspaces w ${scope.sql}`).all(...scope.params) as { id: string }[]
    ).map((w) => w.id);
    const scopeIdList = scopedWorkspaceIds.length > 0 ? scopedWorkspaceIds : ['__no_workspace__'];
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

    const activities = db
      .prepare(
        'SELECT activity_type, metadata FROM task_activities WHERE task_id = ?',
      )
      .all(taskId) as Array<{
      activity_type: string;
      metadata?: string | null;
    }>;

    const deliverables = db
      .prepare('SELECT deliverable_type FROM task_deliverables WHERE task_id = ?')
      .all(taskId) as Array<{ deliverable_type: string }>;

    const progress = computePhaseProgress(activities, deliverables);

    // Determine current_phase: the last label that has been seen or the
    // Teleprompter if its deliverable exists, falling back to the first label
    // whose phase mapped. If nothing is active, current_phase is null.
    let currentPhase: typeof PHASE_LABELS[number] | null = null;
    for (const step of progress.phases) {
      if (step.status !== 'not_started') {
        currentPhase = step.label;
      }
    }
    if (currentPhase == null && activities.length > 0) {
      // An unmapped phase id was in the activities but nothing mapped.
      // current_phase stays null — the client can use the first label as the
      // current position.
    }

    // job_id and terminal are extracted from the task row already fetched
    // (and company-scope-verified) above.
    const terminal = task.status === 'done' || task.status === 'blocked';

    // Per-step artifacts: count of deliverables per label (best-effort).

    return NextResponse.json({
      job_id: taskId,
      terminal,
      current_phase: (currentPhase ?? PHASE_LABELS[0]) as typeof PHASE_LABELS[number],
      phases: progress.phases.map((step) => ({
        id: step.label.toLowerCase(),
        label: step.label,
        status: step.status,
        started_at: step.status !== 'not_started' ? null : null,
        elapsed_s: null as number | null,
        artifacts: [] as string[],
        percent: step.status === 'done' ? 100 : step.status === 'in_progress' ? 50 : 0,
      })),
      unmapped: progress.unmapped,
    });
  } catch (error) {
    console.error('[U060] GET /api/presentations/[taskId]/phases error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
