/**
 * GET /api/tasks/[id]/phases — MR-38 generic lifecycle phase progress.
 *
 * Returns a 6-step lifecycle progress bar (Intake → Planning → Dispatch →
 * Execution → Review → Done) derived from task_events + the task's current
 * status, for ANY department.
 *
 * For presentation tasks, the specialist /api/presentations/[taskId]/phases
 * route provides more granular 7-step progress; the PhaseStepper component
 * prefers that route when the task is presentations, and falls back to this
 * generic route otherwise. Both routes return the same contract so the
 * stepper renders identically regardless of which endpoint fed the data.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { computeTaskProgress, GENERIC_PHASE_LABELS } from '@/lib/task-phases';
import type { TaskEventRow } from '@/lib/task-phases';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { id: taskId } = params;
    const db = getDb();

    // Query task_events for this task (ordered newest-first so the module
    // can walk them chronologically).
    const events = db
      .prepare(
        `SELECT from_status, to_status, created_at, reason
         FROM task_events
         WHERE task_id = ?
         ORDER BY created_at ASC`,
      )
      .all(taskId) as TaskEventRow[];

    // Fallback: current task status so computeTaskProgress can fill gaps
    // when task_events is sparse (the common case today).
    const task = db
      .prepare('SELECT id, status FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; status: string } | undefined;

    const currentStatus = task?.status ?? null;

    const progress = computeTaskProgress(events, currentStatus);

    const terminal = currentStatus === 'done' || currentStatus === 'blocked';

    const doneCount = progress.phases.filter(
      (p) => p.status === 'done' || p.status === 'in_progress',
    ).length;

    return NextResponse.json({
      job_id: taskId,
      terminal,
      current_phase:
        progress.current_label ?? GENERIC_PHASE_LABELS[0],
      phases: progress.phases.map((step) => ({
        id: step.label.toLowerCase(),
        label: step.label,
        status: step.status,
        started_at: null as string | null,
        elapsed_s: null as number | null,
        artifacts: [] as string[],
        percent:
          step.status === 'done'
            ? 100
            : step.status === 'in_progress'
              ? 50
              : 0,
      })),
      unmapped: progress.unmapped,
    });
  } catch (error) {
    console.error('[MR-38] GET /api/tasks/[id]/phases error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
