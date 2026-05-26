import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'child_process';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Task, ActivityType, TaskActivity } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/tasks/[id]/messages — list all messages (task_activities of type 'message')
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const task = queryOne<Task>('SELECT id FROM tasks WHERE id = ?', [id]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const messages = queryAll<{
      id: string;
      task_id: string;
      activity_type: string;
      message: string;
      metadata: string | null;
      created_at: string;
    }>(
      `SELECT id, task_id, activity_type, message, metadata, created_at
       FROM task_activities
       WHERE task_id = ? AND activity_type IN ('message', 'owner_message', 'agent_message')
       ORDER BY created_at ASC`,
      [id]
    );

    return NextResponse.json({ messages });
  } catch (error) {
    console.error('[messages:GET]', error);
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/messages — send a message; runs mid-task mode-switch check
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body: { content: string; sender?: 'owner' | 'agent'; system_context?: string } =
      await request.json();

    if (!body.content?.trim()) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }

    const currentTask = queryOne<Task & {
      persona_id: string | null;
      persona_name: string | null;
      persona_mode: string | null;
      persona_score: number | null;
      department_id: string | null;
    }>(
      `SELECT t.*, a.name as assigned_agent_name
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
       WHERE t.id = ?`,
      [id]
    );

    if (!currentTask) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // ── Mid-task mode-switch check ──────────────────────────────────────────
    // If the task is in_progress and already has a persona+mode assigned,
    // check whether the incoming message should trigger a mode switch.
    // The persona does NOT change — only which section of the blueprint governs.
    if (currentTask.status === 'in_progress' && currentTask.persona_id && currentTask.persona_mode) {
      try {
        const openclaw_root =
          process.env.OPENCLAW_ROOT ||
          (process.platform === 'darwin'
            ? `${process.env.HOME}/.openclaw`
            : '/data/.openclaw');

        const scriptPath = path.join(
          openclaw_root,
          'skills',
          '23-ai-workforce-blueprint',
          'scripts',
          'select-persona-for-task.py'
        );

        const switchOutput = execFileSync(
          'python3',
          [
            scriptPath,
            '--mode-switch',
            '--current-persona', currentTask.persona_id,
            '--current-mode',   currentTask.persona_mode,
            '--message',        body.content,
          ],
          { encoding: 'utf-8', timeout: 5000 }
        );

        const switchResult: {
          persona_id: string;
          mode: string;
          mode_switched: boolean;
          blueprint_section: number;
          instruction: string;
          previous_mode: string;
        } = JSON.parse(switchOutput);

        if (switchResult.mode_switched) {
          // Update the task's active mode
          run(
            `UPDATE tasks SET persona_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [switchResult.mode, currentTask.id]
          );

          // Log the mode switch in persona_selection_log for Intelligence Settings history.
          //
          // Bug 3 (v4.0.2): refuse to insert when task_id is null/empty/sentinel.
          // Orphan rows ('(no-task-id)' sentinel) trigger the FK breakage in
          // migration 034. This is a non-critical log, so skip + warn rather
          // than throw.
          const taskIdForLog = currentTask.id;
          if (
            taskIdForLog == null ||
            taskIdForLog === '' ||
            taskIdForLog === '(no-task-id)'
          ) {
            console.warn(
              '[persona_selection_log] skipping insert: invalid task_id',
              { taskIdForLog }
            );
          } else {
            run(
              `INSERT INTO persona_selection_log
                 (task_id, persona_id, persona_name, mode, score, layer_scores, department_id, selected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
              [
                taskIdForLog,
                switchResult.persona_id,
                currentTask.persona_name,
                switchResult.mode,
                currentTask.persona_score,
                JSON.stringify({ mode_switch: true, previous_mode: switchResult.previous_mode }),
                currentTask.department_id,
              ]
            );
          }

          // Prepend mode-switch instruction so the agent knows which blueprint section to use
          body.system_context = switchResult.instruction;
        }
      } catch {
        // Mode switch detection failed silently — do not block message delivery
      }
    }

    // ── Save the message as a task activity ────────────────────────────────
    const activityType: ActivityType =
      body.sender === 'agent' ? 'agent_message' : 'owner_message';

    const activityId = uuidv4();
    const now = new Date().toISOString();

    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        activityId,
        id,
        activityType,
        body.content.trim(),
        body.system_context ? JSON.stringify({ system_context: body.system_context }) : null,
        now,
      ]
    );

    const activity: TaskActivity = {
      id: activityId,
      task_id: id,
      activity_type: activityType,
      message: body.content.trim(),
      metadata: body.system_context ? JSON.stringify({ system_context: body.system_context }) : undefined,
      created_at: now,
    };

    broadcast({ type: 'task_message', payload: { task_id: id, activity } });

    return NextResponse.json({ activity, system_context: body.system_context || null });
  } catch (error) {
    console.error('[messages:POST]', error);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}
