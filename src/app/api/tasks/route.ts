import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getDb, queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { CreateTaskSchema } from '@/lib/validation';
import type { Task, CreateTaskRequest, Agent } from '@/lib/types';

// GET /api/tasks - List all tasks with optional filters
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const businessId = searchParams.get('business_id');
    const workspaceId = searchParams.get('workspace_id');
    const assignedAgentId = searchParams.get('assigned_agent_id');
    const department = searchParams.get('department');
    const priority = searchParams.get('priority');
    const search = searchParams.get('search')?.trim();
    const rawPage = Number.parseInt(searchParams.get('page') || '1', 10);
    const rawLimit = Number.parseInt(searchParams.get('limit') || '50', 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;

    let sql = `
      SELECT
        t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        ca.name as created_by_agent_name
      FROM tasks t
      LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
      LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (status) {
      // Support comma-separated status values (e.g., status=inbox,testing,in_progress)
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        sql += ' AND t.status = ?';
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        sql += ` AND t.status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      }
    }
    if (businessId) {
      sql += ' AND t.business_id = ?';
      params.push(businessId);
    }
    if (workspaceId) {
      sql += ' AND t.workspace_id = ?';
      params.push(workspaceId);
    }
    if (assignedAgentId) {
      sql += ' AND t.assigned_agent_id = ?';
      params.push(assignedAgentId);
    }
    if (department) {
      sql += ' AND t.department = ?';
      params.push(department);
    }
    if (priority) {
      sql += ' AND t.priority = ?';
      params.push(priority);
    }
    if (search) {
      sql += " AND (LOWER(t.title) LIKE LOWER(?) OR LOWER(COALESCE(t.description, '')) LIKE LOWER(?))";
      params.push(`%${search}%`, `%${search}%`);
    }

    const countSql = sql.replace(
      /SELECT[\s\S]*?FROM tasks t\s+LEFT JOIN agents aa ON t\.assigned_agent_id = aa\.id\s+LEFT JOIN agents ca ON t\.created_by_agent_id = ca\.id/i,
      'SELECT COUNT(*) as count FROM tasks t'
    );
    const totalCount = queryOne<{ count: number }>(countSql, params)?.count ?? 0;

    sql += ' ORDER BY COALESCE(t.position, 0) ASC, t.created_at ASC';
    sql += ' LIMIT ? OFFSET ?';

    const tasks = queryAll<Task & { assigned_agent_name?: string; assigned_agent_emoji?: string; created_by_agent_name?: string }>(sql, [...params, limit, (page - 1) * limit]);

    // Transform to include nested agent info
    const transformedTasks = tasks.map((task) => ({
      ...task,
      assigned_agent: task.assigned_agent_id
        ? {
            id: task.assigned_agent_id,
            name: task.assigned_agent_name,
            avatar_emoji: task.assigned_agent_emoji,
          }
        : undefined,
    }));

    const response = NextResponse.json(transformedTasks);
    response.headers.set('X-Total-Count', String(totalCount));
    response.headers.set('X-Page', String(page));
    response.headers.set('X-Limit', String(limit));
    response.headers.set('X-Total-Pages', String(Math.max(1, Math.ceil(totalCount / limit))));
    return response;
  } catch (error) {
    console.error('Failed to fetch tasks:', error);
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}

// POST /api/tasks - Create a new task
export async function POST(request: NextRequest) {
  try {
    const body: CreateTaskRequest = await request.json();
    console.log('[POST /api/tasks] Received body:', JSON.stringify(body));

    // Validate input with Zod
    const validation = CreateTaskSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const validatedData = validation.data;

    const id = uuidv4();
    const now = new Date().toISOString();

    const workspaceId = validatedData.workspace_id || 'default';
    const status = validatedData.status || 'backlog';
    const maxPosition = queryOne<{ max_position: number | null }>(
      `SELECT MAX(position) as max_position FROM tasks WHERE status = ? AND workspace_id = ?`,
      [status, workspaceId]
    );
    const nextPosition = (maxPosition?.max_position ?? -1) + 1;

    run(
      `INSERT INTO tasks (id, title, description, status, priority, position, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        validatedData.title,
        validatedData.description || null,
        status,
        validatedData.priority || 'medium',
        nextPosition,
        validatedData.assigned_agent_id || null,
        validatedData.created_by_agent_id || null,
        workspaceId,
        validatedData.business_id || 'default',
        validatedData.due_date || null,
        now,
        now,
      ]
    );

    // Log event
    let eventMessage = `New task: ${validatedData.title}`;
    if (validatedData.created_by_agent_id) {
      const creator = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [validatedData.created_by_agent_id]);
      if (creator) {
        eventMessage = `${creator.name} created task: ${validatedData.title}`;
      }
    }

    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), 'task_created', body.created_by_agent_id || null, id, eventMessage, now]
    );

    // Fetch created task with all joined fields
    const task = queryOne<Task>(
      `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        ca.name as created_by_agent_name,
        ca.avatar_emoji as created_by_agent_emoji
       FROM tasks t
       LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
       LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
       WHERE t.id = ?`,
      [id]
    );
    
    // Broadcast task creation via SSE
    if (task) {
      broadcast({
        type: 'task_created',
        payload: task,
      });
    }

    // Trigger webhook for auto-routing asynchronously (don't block response)
    if (task) {
      (async () => {
        try {
          const webhookUrl = `${request.headers.get('origin') || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:4000'}/api/webhooks/task-created`;
          const webhookResponse = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              taskId: task.id,
              title: task.title,
              description: task.description,
              department: task.department,
              priority: task.priority,
              workspaceId: task.workspace_id,
            }),
          });
          if (!webhookResponse.ok) {
            console.error('[POST /api/tasks] Webhook notification failed:', await webhookResponse.text());
          } else {
            console.log('[POST /api/tasks] Webhook notification sent for task:', task.id);
          }
        } catch (webhookError) {
          // Log error but don't fail the task creation
          console.error('[POST /api/tasks] Failed to trigger webhook:', webhookError);
        }
      })();
    }
    
    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    console.error('Failed to create task:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}

// PUT /api/tasks - Bulk reorder tasks
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const updates = body?.updates as Array<{ id: string; position: number; status?: string }> | undefined;

    if (!Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json({ error: 'updates must be a non-empty array' }, { status: 400 });
    }

    const db = getDb();
    const now = new Date().toISOString();
    const updateStmt = db.prepare('UPDATE tasks SET position = ?, status = COALESCE(?, status), updated_at = ? WHERE id = ?');

    db.transaction(() => {
      for (const update of updates) {
        if (!update?.id || typeof update.position !== 'number') {
          throw new Error('Invalid reorder payload');
        }
        updateStmt.run(update.position, update.status ?? null, now, update.id);
      }
    })();

    const updatedIds = updates.map((update) => update.id);
    const placeholders = updatedIds.map(() => '?').join(', ');
    const updatedTasks = queryAll<Task>(
      `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        ca.name as created_by_agent_name
       FROM tasks t
       LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
       LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
       WHERE t.id IN (${placeholders})`,
      updatedIds
    );

    for (const task of updatedTasks) {
      broadcast({
        type: 'task_updated',
        payload: task,
      });
    }

    return NextResponse.json({ success: true, count: updatedTasks.length });
  } catch (error) {
    console.error('Failed to reorder tasks:', error);
    return NextResponse.json({ error: 'Failed to reorder tasks' }, { status: 500 });
  }
}
