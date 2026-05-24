import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { CreateTaskSchema } from '@/lib/validation';
import { selectPersonaForTask } from '@/lib/persona-selector';
import type { Task, CreateTaskRequest, Agent } from '@/lib/types';
import { getBestSOPForTask } from '@/lib/sops';

// GET /api/tasks - List all tasks with optional filters
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const businessId = searchParams.get('business_id');
    const workspaceId = searchParams.get('workspace_id');
    const assignedAgentId = searchParams.get('assigned_agent_id');
    const department = searchParams.get('department');
    const departmentId = searchParams.get('department_id');

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
    if (departmentId) {
      // department_id maps to workspace_id (workspaces = departments)
      sql += ' AND t.workspace_id = ?';
      params.push(departmentId);
    }

    sql += ' ORDER BY t.created_at DESC';

    const tasks = queryAll<Task & { assigned_agent_name?: string; assigned_agent_emoji?: string; created_by_agent_name?: string }>(sql, params);

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

    return NextResponse.json(transformedTasks);
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

    // Auto-suggest SOP if none provided. Scored by department + keyword overlap;
    // anything below 0.5 leaves sop_id NULL so the operator picks manually.
    let sopId: string | null = validatedData.sop_id ?? null;
    if (!sopId) {
      try {
        const best = getBestSOPForTask({
          title: validatedData.title,
          description: validatedData.description,
          department: validatedData.department,
          workspace_id: workspaceId,
        });
        if (best) sopId = best.id;
      } catch (err) {
        console.warn('[POST /api/tasks] SOP auto-suggest failed (non-fatal):', err);
      }
    }

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, department, due_date, sop_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        validatedData.title,
        validatedData.description || null,
        status,
        validatedData.priority || 'medium',
        validatedData.assigned_agent_id || null,
        validatedData.created_by_agent_id || null,
        workspaceId,
        validatedData.business_id || 'default',
        validatedData.department || null,
        validatedData.due_date || null,
        sopId,
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

    // Persona selection (Hop 10): spawn persona-selector-v2.py and pin the
    // result onto the new task before we re-fetch. Failures are non-blocking
    // — task creation must still succeed if the selector can't run.
    //
    // Skips known sentinel/fallback IDs ("schemaVersion" et al.) that come
    // out of an unpatched selector on a stale install — see the Hop 10
    // selector bug-hunt notes.
    try {
      const taskDescription =
        `${validatedData.title}${validatedData.description ? `. ${validatedData.description}` : ''}`.trim();
      const departmentForSelector = workspaceId || 'general';

      const persona = await selectPersonaForTask(id, taskDescription, departmentForSelector);

      const SENTINEL_IDS = new Set([
        'schemaVersion',
        'created',
        'domainTags',
        'perspectiveTags',
        'personas',
      ]);

      if (
        persona &&
        persona.persona_id &&
        !SENTINEL_IDS.has(persona.persona_id) &&
        !persona.no_persona_required
      ) {
        const personaSelectedAt = new Date().toISOString();
        run(
          `UPDATE tasks
              SET persona_id = ?,
                  persona_name = ?,
                  persona_mode = ?,
                  persona_score = ?,
                  persona_version = ?,
                  persona_selected_at = ?
            WHERE id = ?`,
          [
            persona.persona_id,
            persona.persona_name,
            persona.interaction_mode,
            persona.score ?? null,
            persona.persona_version ?? 1,
            personaSelectedAt,
            id,
          ]
        );
        console.log(
          `[POST /api/tasks] Persona assigned: task=${id} persona=${persona.persona_id} ` +
            `score=${persona.score?.toFixed(3) ?? '?'} mode=${persona.interaction_mode}`
        );
      } else if (persona && persona.persona_id && SENTINEL_IDS.has(persona.persona_id)) {
        console.warn(
          `[POST /api/tasks] Persona selector returned sentinel id "${persona.persona_id}" for task ${id} — ignoring (selector needs patching).`
        );
      } else {
        console.warn(`[POST /api/tasks] No persona assigned for task ${id} (selector returned ${persona ? 'unusable result' : 'null'}).`);
      }
    } catch (personaError) {
      // Never fail task creation on persona-selector errors.
      console.error(`[POST /api/tasks] Persona selection threw for task ${id}:`, personaError);
    }

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
