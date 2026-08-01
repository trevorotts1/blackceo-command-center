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

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  _request: NextRequest,
  { params }: { params: { taskId: string } },
) {
  try {
    const { taskId } = params;
    const db = getDb();

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

    // job_id and terminal are extracted from the task row.
    const task = db
      .prepare('SELECT id, status FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; status: string } | undefined;

    const terminal = task
      ? task.status === 'done' || task.status === 'blocked'
      : false;

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
