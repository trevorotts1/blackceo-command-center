import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import type { DeptMemory, UpdateDeptMemoryRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// DELETE /api/dept-memory/[id] -- remove a memory
export async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { companyId } = await resolveTenantContext(request);
    const { id } = params;

    const existing = queryOne<DeptMemory>('SELECT m.* FROM dept_memory m JOIN workspaces w ON w.id=m.workspace_id WHERE m.id=? AND w.company_id=?', [id, companyId]);
    if (!existing) {
      return NextResponse.json({ error: 'Memory not found' }, { status: 404 });
    }

    run('DELETE FROM dept_memory WHERE id=? AND workspace_id IN (SELECT id FROM workspaces WHERE company_id=?)', [id, companyId]);

    return NextResponse.json({ success: true, deleted: id });
  } catch (error) {
    if (error instanceof TenantAccessError) return NextResponse.json({ error: 'Verified company identity required' }, { status: 403 });
    console.error('DELETE /api/dept-memory/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to delete department memory' },
      { status: 500 }
    );
  }
}

// PATCH /api/dept-memory/[id] -- update importance or content
export async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { companyId } = await resolveTenantContext(request);
    const { id } = params;
    const body = (await request.json()) as UpdateDeptMemoryRequest;

    const existing = queryOne<DeptMemory>('SELECT m.* FROM dept_memory m JOIN workspaces w ON w.id=m.workspace_id WHERE m.id=? AND w.company_id=?', [id, companyId]);
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
    values.push(id, companyId);

    run(
      `UPDATE dept_memory SET ${updates.join(', ')} WHERE id=? AND workspace_id IN (SELECT id FROM workspaces WHERE company_id=?)`,
      values
    );

    const updated = queryOne<DeptMemory>('SELECT m.* FROM dept_memory m JOIN workspaces w ON w.id=m.workspace_id WHERE m.id=? AND w.company_id=?', [id, companyId]);

    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    if (error instanceof TenantAccessError) return NextResponse.json({ error: 'Verified company identity required' }, { status: 403 });
    console.error('PATCH /api/dept-memory/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to update department memory' },
      { status: 500 }
    );
  }
}
