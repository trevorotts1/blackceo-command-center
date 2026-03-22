import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { ExecutionQueueItem } from '@/lib/types';

// PATCH /api/execution-queue/[id] - Update a queue item
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    // Check item exists
    const existing = queryOne<ExecutionQueueItem>(
      'SELECT * FROM execution_queue WHERE id = ?',
      [id]
    );

    if (!existing) {
      return NextResponse.json(
        { error: 'Queue item not found' },
        { status: 404 }
      );
    }

    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.status) {
      updates.push('status = ?');
      values.push(body.status);

      if (body.status === 'running') {
        updates.push('started_at = ?');
        values.push(now);
      }

      if (body.status === 'completed' || body.status === 'failed') {
        updates.push('completed_at = ?');
        values.push(now);
      }
    }

    if (body.result_notes !== undefined) {
      updates.push('result_notes = ?');
      values.push(body.result_notes);
    }

    if (body.scheduled_window) {
      updates.push('scheduled_window = ?');
      values.push(body.scheduled_window);
    }

    updates.push('updated_at = ?');
    values.push(now);

    if (updates.length === 1) {
      // Only updated_at, nothing meaningful to update
      return NextResponse.json(existing);
    }

    values.push(id);
    run(
      `UPDATE execution_queue SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    const updated = queryOne<ExecutionQueueItem>(
      'SELECT * FROM execution_queue WHERE id = ?',
      [id]
    );

    if (updated) {
      broadcast({
        type: 'execution_queue_updated',
        payload: updated,
      });
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Failed to update execution queue item:', error);
    return NextResponse.json(
      { error: 'Failed to update execution queue item' },
      { status: 500 }
    );
  }
}

// DELETE /api/execution-queue/[id] - Remove from queue
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const existing = queryOne<ExecutionQueueItem>(
      'SELECT * FROM execution_queue WHERE id = ?',
      [id]
    );

    if (!existing) {
      return NextResponse.json(
        { error: 'Queue item not found' },
        { status: 404 }
      );
    }

    run('DELETE FROM execution_queue WHERE id = ?', [id]);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete execution queue item:', error);
    return NextResponse.json(
      { error: 'Failed to delete execution queue item' },
      { status: 500 }
    );
  }
}
