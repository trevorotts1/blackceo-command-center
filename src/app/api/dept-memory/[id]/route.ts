import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import type { DeptMemory, UpdateDeptMemoryRequest } from '@/lib/types';

// DELETE /api/dept-memory/[id] -- remove a memory
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;

    const existing = queryOne<DeptMemory>('SELECT id FROM dept_memory WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Memory not found' }, { status: 404 });
    }

    run('DELETE FROM dept_memory WHERE id = ?', [id]);

    return NextResponse.json({ success: true, deleted: id });
  } catch (error) {
    console.error('DELETE /api/dept-memory/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to delete department memory' },
      { status: 500 }
    );
  }
}

// PATCH /api/dept-memory/[id] -- update importance or content
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const body = (await request.json()) as UpdateDeptMemoryRequest;

    const existing = queryOne<DeptMemory>('SELECT * FROM dept_memory WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Memory not found' }, { status: 404 });
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.content !== undefined) {
      updates.push('content = ?');
      values.push(body.content);
    }
    if (body.importance !== undefined) {
      if (body.importance < 1 || body.importance > 5) {
        return NextResponse.json(
          { error: 'importance must be between 1 and 5' },
          { status: 400 }
        );
      }
      updates.push('importance = ?');
      values.push(body.importance);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    run(
      `UPDATE dept_memory SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    const updated = queryOne<DeptMemory>('SELECT * FROM dept_memory WHERE id = ?', [id]);

    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error('PATCH /api/dept-memory/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to update department memory' },
      { status: 500 }
    );
  }
}
