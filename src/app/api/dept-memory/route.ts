import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import type { DeptMemory, CreateDeptMemoryRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/dept-memory?workspace_id=X -- get all memories for a dept
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id');
    const { companyId } = await resolveTenantContext(request);
    if (!workspaceId) return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    if (!queryOne('SELECT id FROM workspaces WHERE id=? AND company_id=?', [workspaceId, companyId])) {
      return NextResponse.json({ error: 'Department not found' }, { status: 404 });
    }

    const memories = queryAll<DeptMemory>(
      `SELECT id, workspace_id, memory_type, content, created_by, importance, created_at, updated_at
       FROM dept_memory
       WHERE workspace_id = ? AND EXISTS (
         SELECT 1 FROM workspaces w WHERE w.id=dept_memory.workspace_id AND w.company_id=?)
       ORDER BY importance DESC, created_at DESC`,
      [workspaceId, companyId]
    );

    return NextResponse.json({ data: memories });
  } catch (error) {
    if (error instanceof TenantAccessError) return NextResponse.json({ error: 'Verified company identity required' }, { status: 403 });
    console.error('GET /api/dept-memory error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch department memories' },
      { status: 500 }
    );
  }
}

// POST /api/dept-memory -- add a new memory
export async function POST(request: NextRequest) {
  try {
    const { companyId } = await resolveTenantContext(request);
    const body = (await request.json()) as CreateDeptMemoryRequest;
    const { workspace_id, memory_type, content, created_by = 'system', importance = 3 } = body;

    if (!workspace_id || !memory_type || !content) {
      return NextResponse.json(
        { error: 'Missing required fields: workspace_id, memory_type, content' },
        { status: 400 }
      );
    }

    const validTypes = ['decision', 'context', 'lesson', 'goal', 'constraint'];
    if (!validTypes.includes(memory_type)) {
      return NextResponse.json(
        { error: `Invalid memory_type. Must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    if (!queryOne('SELECT id FROM workspaces WHERE id=? AND company_id=? AND archived_at IS NULL', [workspace_id, companyId])) {
      return NextResponse.json({ error: 'Department not found' }, { status: 404 });
    }
    const id = uuidv4();
    const now = new Date().toISOString();

    run(
      `INSERT INTO dept_memory (id, workspace_id, memory_type, content, created_by, importance, created_at, updated_at)
       SELECT ?, id, ?, ?, ?, ?, ?, ? FROM workspaces WHERE id=? AND company_id=? AND archived_at IS NULL`,
      [id, memory_type, content, created_by, importance, now, now, workspace_id, companyId]
    );

    const inserted = queryOne<DeptMemory>(
      'SELECT * FROM dept_memory WHERE id = ?',
      [id]
    );

    if (!inserted) return NextResponse.json({ error: 'Department not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: inserted }, { status: 201 });
  } catch (error) {
    if (error instanceof TenantAccessError) return NextResponse.json({ error: 'Verified company identity required' }, { status: 403 });
    console.error('POST /api/dept-memory error:', error);
    return NextResponse.json(
      { error: 'Failed to create department memory' },
      { status: 500 }
    );
  }
}
