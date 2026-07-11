/**
 * POST   /api/tasks/[id]/archive — soft-archive a task (stamp archived_at).
 * DELETE /api/tasks/[id]/archive — un-archive it (clear archived_at).
 *
 * B8 / AUD-46. This is the FIRST HALF of the two-step the delete guard enforces,
 * and until now it did not exist as an API at all: `tasks.archived_at` (migration
 * 058) was only ever stamped by the weekly Done-clear job, and PATCH /api/tasks/[id]
 * does not accept the field. So there was no way to take a card off the board
 * WITHOUT destroying it — which is precisely why hard DELETE was reached for.
 *
 * Shipping the guard without this route would have made DELETE unreachable rather
 * than deliberate. A gate you cannot pass is a wall, not a gate.
 *
 * Soft-archive is LOSSLESS: the row and every child record survive, the board hides
 * the card (GET /api/tasks filters `archived_at IS NULL`), and `?includeArchived=true`
 * still returns it. Un-archiving puts it straight back.
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Idempotent: COALESCE keeps the ORIGINAL archived_at, so re-archiving never
    // rewrites history to a fresher (and less honest) timestamp.
    run(
      `UPDATE tasks
          SET archived_at = COALESCE(archived_at, ?), updated_at = ?
        WHERE id = ?`,
      [new Date().toISOString(), new Date().toISOString(), id],
    );

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    broadcast({ type: 'task_updated', payload: task as Task });

    return NextResponse.json({
      ok: true,
      id,
      archived_at: task?.archived_at ?? null,
      note:
        'Task soft-archived — hidden from the board, row PRESERVED. Retrieve with ' +
        '?includeArchived=true, restore with DELETE on this same route. It is now ' +
        'also eligible for a hard DELETE /api/tasks/' + id + ' (irreversible).',
    });
  } catch (error) {
    console.error('Failed to archive task:', error);
    return NextResponse.json({ error: 'Failed to archive task' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    run('UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?', [
      new Date().toISOString(),
      id,
    ]);

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    broadcast({ type: 'task_updated', payload: task as Task });

    return NextResponse.json({ ok: true, id, archived_at: null, note: 'Task restored to the board.' });
  } catch (error) {
    console.error('Failed to un-archive task:', error);
    return NextResponse.json({ error: 'Failed to un-archive task' }, { status: 500 });
  }
}
