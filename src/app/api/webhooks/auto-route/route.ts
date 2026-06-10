import { NextRequest, NextResponse } from 'next/server';
import { run, queryOne } from '@/lib/db';
import { routeTask } from '@/lib/routing/department-router';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/webhooks/auto-route
 *
 * Automatically routes an incoming task to the best available agent using
 * the DepartmentRouter (keyword scoring + load balancing).
 *
 * Request body:
 *   taskId      string   required — ID of the task to route
 *   workspaceId string   optional — defaults to 'default'
 *
 * The endpoint:
 *   1. Loads the task from the DB
 *   2. Runs comDispatch() to score departments and pick the best agent
 *   3. Updates the task's assigned_agent_id if an agent is found
 *   4. Returns the routing decision (or a 404/422 if routing fails)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { taskId, workspaceId } = body as { taskId?: string; workspaceId?: string };

    if (!taskId) {
      return NextResponse.json(
        { error: 'Missing required field: taskId' },
        { status: 400 },
      );
    }

    // Fetch the task so we have full context for routing
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) {
      return NextResponse.json({ error: `Task not found: ${taskId}` }, { status: 404 });
    }

    // Use workspaceId from body if provided, otherwise fall back to task's workspace
    const effectiveWorkspaceId = workspaceId || task.workspace_id || 'default';

    const routingInput = {
      title: task.title,
      description: task.description || '',
      priority: task.priority,
      workspace_id: effectiveWorkspaceId,
      department: task.department,
    };

    const result = await routeTask(routingInput);

    if (!result) {
      return NextResponse.json(
        {
          success: false,
          routed: false,
          taskId,
          reason: 'No suitable agent available for this task',
        },
        { status: 422 },
      );
    }

    // Assign the agent and advance the task out of backlog → in_progress so
    // the re-dispatched task is visible to the specialist and leaves the backlog.
    // Only move from backlog; tasks already in_progress/review/done are left alone.
    const now = new Date().toISOString();
    run(
      `UPDATE tasks
       SET assigned_agent_id = ?,
           status = CASE WHEN status = 'backlog' THEN 'in_progress' ELSE status END,
           updated_at = ?
       WHERE id = ?`,
      [result.agentId, now, taskId],
    );

    console.log(
      `[AutoRoute] Task "${task.title}" (${taskId}) assigned to ${result.agentName} via ${result.department} → in_progress`,
    );

    // AUTO-DISPATCH (v4.14.0): fire OpenClaw invocation immediately after routing.
    // autoDispatchTask guards against master/CEO agents and terminal statuses.
    // Fire-and-forget so routing response is not blocked by OpenClaw latency.
    void autoDispatchTask(taskId, 'auto-route');

    return NextResponse.json({
      success: true,
      routed: true,
      taskId,
      agentId: result.agentId,
      agentName: result.agentName,
      department: result.department,
      score: result.score,
      reason: result.reason,
    });
  } catch (error) {
    console.error('[AutoRoute] Error processing auto-route webhook:', error);
    return NextResponse.json(
      { error: 'Failed to process auto-route request' },
      { status: 500 },
    );
  }
}

/**
 * GET /api/webhooks/auto-route?taskId=<id>
 *
 * Dry-run mode: returns the routing decision WITHOUT updating the task.
 * Useful for previewing which agent would be selected and why.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId');
    const workspaceId = searchParams.get('workspaceId') || undefined;

    if (!taskId) {
      return NextResponse.json(
        { error: 'Missing required query param: taskId' },
        { status: 400 },
      );
    }

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) {
      return NextResponse.json({ error: `Task not found: ${taskId}` }, { status: 404 });
    }

    const effectiveWorkspaceId = workspaceId || task.workspace_id || 'default';

    const result = await routeTask({
      title: task.title,
      description: task.description || '',
      priority: task.priority,
      workspace_id: effectiveWorkspaceId,
      department: task.department,
    });

    return NextResponse.json({
      dryRun: true,
      taskId,
      routed: !!result,
      routing: result ?? null,
    });
  } catch (error) {
    console.error('[AutoRoute] Error in dry-run routing:', error);
    return NextResponse.json(
      { error: 'Failed to compute routing' },
      { status: 500 },
    );
  }
}
