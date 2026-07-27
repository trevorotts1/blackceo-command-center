import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import { transition, TransitionError } from '@/lib/task-lifecycle';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/tasks/[id]/resume — U061 step 5
 *
 * Re-enters a blocked task into the dispatch loop. Routes through the state
 * machine (transition()), never a raw UPDATE. Idempotent: a second call on an
 * already-resumed task returns success without firing a second dispatch.
 *
 * Decision recorded in ticket U061: Resume PRESERVES dispatch_attempts (does
 * not reset to 0). Resetting would turn a capped retry loop into an unbounded
 * one, defeating the block-on-N cap (migration 077). The operator can reset
 * the counter manually via the database if that is the intent.
 *
 * Racing the heal loop: if next_dispatch_eligible_at is in the future, this
 * route clears it so the dispatch is immediate.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Guard: only blocked tasks may be resumed
    if (task.status !== 'blocked') {
      return NextResponse.json(
        {
          error: 'Only blocked tasks can be resumed',
          detail: `Task ${id} is in status '${task.status}', not 'blocked'`,
        },
        { status: 409 },
      );
    }

    // Idempotency: if the task has already left 'blocked' between our read
    // and the CAS inside transition(), transition() throws CAS_CONFLICT.
    // Catch it and re-check: if the task is no longer blocked, another caller
    // already resumed it — return success.
    try {
      const fromStatus = task.status;
      await transition(id, 'backlog', {
        actor: 'system',
        reason: 'Operator resumed from blocked via /api/tasks/[id]/resume',
        expectedFrom: fromStatus,
      });
    } catch (err) {
      if (err instanceof TransitionError && err.code === 'CAS_CONFLICT') {
        // Re-read the task — if it is no longer blocked, another Resume (or
        // heal loop) already moved it. That is success from the caller's
        // perspective.
        const fresh = queryOne<Pick<Task, 'status'>>(
          'SELECT status FROM tasks WHERE id = ?',
          [id],
        );
        if (!fresh) {
          return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }
        if (fresh.status !== 'blocked') {
          return NextResponse.json({
            success: true,
            detail: `Task was already resumed by another caller — current status: ${fresh.status}`,
          });
        }
        // Still blocked — the CAS failure was for a different reason. Re-throw.
        throw err;
      }
      throw err;
    }

    // Clear the backoff gate so dispatch can proceed immediately
    run('UPDATE tasks SET next_dispatch_eligible_at = NULL WHERE id = ?', [id]);

    // Record a task_activities row so the activity trail and U060's stepper see it
    const now = new Date().toISOString();
    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        id,
        'resume_from_blocked',
        `Task "${task.title}" resumed from blocked — re-entering dispatch loop`,
        now,
      ],
    );

    const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);

    return NextResponse.json({
      success: true,
      task: updated,
    });
  } catch (error) {
    console.error('[resume] Failed to resume task:', error);
    if (error instanceof TransitionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: 'Failed to resume task' },
      { status: 500 },
    );
  }
}
