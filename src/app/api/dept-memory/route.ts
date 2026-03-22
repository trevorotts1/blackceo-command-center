import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { seedDeptMemory } from '@/lib/db/seed-dept-memory';
import type { DeptMemory, CreateDeptMemoryRequest } from '@/lib/types';

// GET /api/dept-memory?workspace_id=X -- get all memories for a dept
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id') || 'default';

    // Auto-seed if table is empty
    seedDeptMemory();

    const memories = queryAll<DeptMemory>(
      `SELECT id, workspace_id, memory_type, content, created_by, importance, created_at, updated_at
       FROM dept_memory
       WHERE workspace_id = ?
       ORDER BY importance DESC, created_at DESC`,
      [workspaceId]
    );

    return NextResponse.json({ data: memories });
  } catch (error) {
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

    const id = uuidv4();
    const now = new Date().toISOString();

    run(
      `INSERT INTO dept_memory (id, workspace_id, memory_type, content, created_by, importance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, workspace_id, memory_type, content, created_by, importance, now, now]
    );

    const inserted = queryOne<DeptMemory>(
      'SELECT * FROM dept_memory WHERE id = ?',
      [id]
    );

    return NextResponse.json({ success: true, data: inserted }, { status: 201 });
  } catch (error) {
    console.error('POST /api/dept-memory error:', error);
    return NextResponse.json(
      { error: 'Failed to create department memory' },
      { status: 500 }
    );
  }
}
