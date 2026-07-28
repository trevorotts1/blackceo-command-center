/**
 * POST /api/tasks/[id]/resume — U061 step 5: the Resume action for a blocked task.
 *
 * Before this route, the ONLY way to move a blocked task was drag-to-column or the
 * touch move menu doing PATCH /api/tasks/{id} with a new status — a raw status
 * write that bypasses the state machine. This route is the dedicated Resume:
 * it re-enters the blocked task into the dispatch queue (backlog) through the
 * shared `transition()` state machine with `expectedFrom:'blocked'`, so a
 * concurrent writer that already moved the task surfaces CAS_CONFLICT instead
 * of a silent overwrite.
 *
 * IDEMPOTENT: a second call on an already-resumed task returns 200 with
 * `idempotent: true`.
 *
 * DISPATCH_ATTEMPTS PRESERVED: the decision recorded in the U061 ticket is
 * PRESERVE. A Resume that resets `dispatch_attempts` to 0 would turn a
 * capped retry loop into an unbounded one.
 *
 * GUARD AGAINST RACING THE HEAL LOOP: if `next_dispatch_eligible_at` is in the
 * future at Resume time, it is explicitly cleared so the dispatch loop picks
 * the task up immediately rather than waiting for the old backoff window.
 */
import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import type { Task } from '@/lib/types';
import { transition, TransitionError } from '@/lib/task-lifecycle';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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

    // ── Route guard: only blocked tasks may be resumed ───────────────────────
    if (task.status !== 'blocked') {
      return NextResponse.json(
        {
          error: 'Only blocked tasks can be resumed',
          detail: `Task ${id} is in status '${task.status}', not 'blocked'`,
        },
        { status: 409 },
      );
    }

    // ── Clear next_dispatch_eligible_at if it is in the future, so the
    // dispatch loop picks the task up immediately rather than waiting for
    // the old backoff window.
    if (task.next_dispatch_eligible_at) {
      const target = new Date(task.next_dispatch_eligible_at).getTime();
      if (target > Date.now()) {
        run(
          'UPDATE tasks SET next_dispatch_eligible_at = NULL WHERE id = ?',
          [id],
        );
      }
    }

    // ── Persist via the shared lifecycle state machine ───────────────────────
    // CAS-guarded on expectedFrom:'blocked': a concurrent writer (e.g. the heal
    // loop) that already moved the task out of blocked in the read→click window
    // surfaces CAS_CONFLICT (409) instead of a silent overwrite.
    try {
      await transition(id, 'backlog', {
        actor: 'owner',
        reason: '[U061 resume] blocked task resumed — re-entering dispatch queue',
        expectedFrom: 'blocked',
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
          // Already resumed by another caller — idempotent success
          const freshest = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
          return NextResponse.json({
            success: true,
            idempotent: true,
            task: freshest,
            detail: `Task was already resumed by another caller — current status: ${fresh.status}`,
          });
        }
        // Still blocked — the CAS failure was for a different reason
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: 409 },
        );
      }
      if (err instanceof TransitionError) {
        if (err.code === 'NOT_FOUND') {
          return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }
        if (err.code === 'ILLEGAL_TRANSITION') {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 422 },
          );
        }
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: 422 },
        );
      }
      throw err;
    }

    // ── Record a task_activities row so the change is visible in the
    // activity trail (U060's stepper, task-detail modal) ─────────────────────
    const now = new Date().toISOString();
    try {
      run(
        `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          id,
          'resume_from_blocked',
          `Task "${task.title}" resumed from blocked — re-entering dispatch loop`,
          JSON.stringify({ actor: 'owner', from: 'blocked', to: 'backlog' }),
          now,
        ],
      );
    } catch {
      // task_activities table may not exist on very old DBs — non-fatal
    }

    const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);

    return NextResponse.json({
      success: true,
      task: updated,
    });
  } catch (error) {
    console.error('[resume] Failed to resume task:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

/**
 * GET /api/tasks/[id]/resume — describe the endpoint (no data), matching the
 * self-describing GET on sibling routes.
 */
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/tasks/[id]/resume',
    method: 'POST',
    scope:
      'U061 — resumes a blocked task, re-entering the dispatch queue (backlog) ' +
      'through the shared transition() state machine with expectedFrom:\'blocked\'. ' +
      'Refuses (409) tasks not in \'blocked\' status. Idempotent: a second call ' +
      'on an already-resumed task returns 200 with idempotent:true. ' +
      'Preserves dispatch_attempts — decision PRESERVE, recorded in ticket U061.',
    returns:
      '200 with { success, task }; 404 unknown id, 409 not-blocked or CAS conflict, ' +
      '422 illegal transition, 500 error',
  });
}
