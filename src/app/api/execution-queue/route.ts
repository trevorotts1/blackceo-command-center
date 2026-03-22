import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { ExecutionQueueItem } from '@/lib/types';

// GET /api/execution-queue - List all queued items with computed display status
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    let sql = 'SELECT * FROM execution_queue WHERE 1=1';
    const params: unknown[] = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY queued_at DESC LIMIT ?';
    params.push(limit);

    const items = queryAll<ExecutionQueueItem>(sql, params);

    // Compute display status based on current time
    const now = new Date();
    const hour = now.getHours();
    const isExecutionWindow = hour >= 17 || hour < 9; // 5pm-9am

    const itemsWithDisplayStatus = items.map((item) => ({
      ...item,
      display_status:
        item.status === 'completed' || item.status === 'failed'
          ? item.status
          : isExecutionWindow
          ? 'running'
          : 'queued',
    }));

    return NextResponse.json(itemsWithDisplayStatus);
  } catch (error) {
    console.error('Failed to fetch execution queue:', error);
    return NextResponse.json(
      { error: 'Failed to fetch execution queue' },
      { status: 500 }
    );
  }
}

// POST /api/execution-queue - Add item to the queue
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body.task_name || typeof body.task_name !== 'string') {
      return NextResponse.json(
        { error: 'task_name is required' },
        { status: 400 }
      );
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    run(
      `INSERT INTO execution_queue (id, task_id, recommendation_id, task_name, department, queued_at, scheduled_window, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        id,
        body.task_id || null,
        body.recommendation_id || null,
        body.task_name,
        body.department || null,
        now,
        body.scheduled_window || 'evening',
        now,
        now,
      ]
    );

    const item = queryOne<ExecutionQueueItem>(
      'SELECT * FROM execution_queue WHERE id = ?',
      [id]
    );

    if (item) {
      broadcast({
        type: 'execution_queue_updated',
        payload: item,
      });
    }

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    console.error('Failed to add to execution queue:', error);
    return NextResponse.json(
      { error: 'Failed to add to execution queue' },
      { status: 500 }
    );
  }
}
