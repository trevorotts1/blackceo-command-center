import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { run, queryOne } from '@/lib/db';
import { routeTask } from '@/lib/routing/department-router';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import type { Task } from '@/lib/types';
import { notifyOwnerAssigned } from '@/lib/owner-reports';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Verify the HMAC-SHA256 signature of the webhook request (DATA-09).
 *
 * Mirrors /api/webhooks/agent-completion: the caller signs the RAW request body
 * with WEBHOOK_SECRET and sends the hex digest in `x-webhook-signature`. The
 * middleware supplies the Bearer (MC_API_TOKEN) layer for external callers;
 * this HMAC is the per-request second factor so the route is never an
 * unauthenticated write surface even if the middleware layer is bypassed.
 *
 * When WEBHOOK_SECRET is unset we skip (dev): safe because this route is now in
 * the middleware's WEBHOOK_SECRET_ROUTES fail-closed family, so a production box
 * without WEBHOOK_SECRET is refused at the gate (503) before reaching here.
 * Comparison is constant-time.
 */
function verifyWebhookSignature(signature: string | null, rawBody: string): boolean {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) return true;
  if (!signature) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const sig = Buffer.from(signature);
  const exp = Buffer.from(expected);
  if (sig.length !== exp.length) return false;
  return timingSafeEqual(sig, exp);
}

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
    // DATA-09: route-level HMAC auth (Bearer is enforced by middleware).
    const rawBody = await request.text();
    if (process.env.WEBHOOK_SECRET) {
      const signature = request.headers.get('x-webhook-signature');
      if (!signature || !verifyWebhookSignature(signature, rawBody)) {
        console.warn('[AutoRoute] Invalid webhook signature attempt');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
    const body = JSON.parse(rawBody);
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

    // Assign the agent ONLY — leave status at backlog. autoDispatchTask is the
    // single authority that flips backlog → in_progress, and it only does so
    // AFTER chat.send actually reaches the specialist (see task-dispatcher.ts).
    //
    // G8-KANBAN fix: the previous code pre-set status='in_progress' here, which
    // tripped autoDispatchTask GUARD 3 (SKIP_STATUSES includes 'in_progress'),
    // so the OpenClaw invocation returned before chat.send — the card showed
    // "In Progress" but the agent was never actually invoked. Mirroring
    // createTaskCore (assign → leave backlog → let autoDispatchTask flip) is the
    // only correct pattern. If dispatch aborts (gateway down / sovereignty / SOP
    // hold) the task stays assigned-in-backlog and the backlog-redispatch sweep
    // rescues it.
    const now = new Date().toISOString();
    run(
      `UPDATE tasks
       SET assigned_agent_id = ?,
           updated_at = ?
       WHERE id = ?`,
      [result.agentId, now, taskId],
    );

    console.log(
      `[AutoRoute] Task "${task.title}" (${taskId}) assigned to ${result.agentName} via ${result.department} → backlog (awaiting auto-dispatch)`,
    );

    // W5.2 — ASSIGNMENT owner notification (spec §5): "I'm sending this task to the [Dept] department."
    // Best-effort; gateway-routed; never blocks response or rolls back DB state.
    try { notifyOwnerAssigned(taskId, { department: result.department }); } catch { /* non-fatal */ }

    // AUTO-DISPATCH (v4.14.0): fire OpenClaw invocation immediately after routing.
    // autoDispatchTask guards against master/CEO agents and terminal statuses and
    // performs the backlog → in_progress flip itself once chat.send succeeds.
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
