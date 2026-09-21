/**
 * auto-route.ts — route a task to its best agent and fire dispatch, IN PROCESS.
 *
 * WHY THIS EXISTS
 * ---------------
 * This logic used to live only inside `POST /api/webhooks/auto-route`, so the
 * one other caller that needed it — the QC scorer's re-route after a FAIL —
 * reached it by HTTP-ing the box it was already running on. That self-call sent
 * no credentials, and `/api/webhooks/auto-route` is in the middleware's
 * `WEBHOOK_SECRET_ROUTES` family, which is deliberately EXCLUDED from the
 * same-origin passthrough. So every QC-failed card logged
 *
 *     [QCScorer] Auto-route returned 401 for task <id> — stays in backlog
 *
 * and sat there until the 5-minute ceo-delegation sweep picked it up.
 *
 * Signing the self-call would have meant reproducing BOTH layers the route
 * demands of an external caller — the middleware's `Authorization: Bearer
 * MC_API_TOKEN` and the route's own HMAC-SHA256 of the raw body over
 * WEBHOOK_SECRET — plus guessing the box's own base URL, which is its own
 * historical bug (the `getMissionControlUrl()` port-3000/4000 comment the old
 * call site carried). All of that to reach a function in the same process.
 *
 * So the routing decision lives here instead. The webhook route keeps its auth
 * and becomes a thin HTTP wrapper; in-process callers call this directly and
 * need no credentials, because there is no request to authenticate.
 *
 * SERVER-ONLY (touches the DB and the dispatcher).
 */

import { run, queryOne } from '@/lib/db';
import { routeTask } from '@/lib/routing/department-router';
import { notifyOwnerAssigned } from '@/lib/owner-reports';
import type { Task } from '@/lib/types';

/** Why a routing attempt produced no assignment. Maps 1:1 to the route's status codes. */
export type AutoRouteFailure = 'task-not-found' | 'no-agent-available';

export type AutoRouteResult =
  | {
      routed: true;
      taskId: string;
      agentId: string;
      agentName: string;
      department: string;
      score: number;
      reason: string;
    }
  | { routed: false; taskId: string; failure: AutoRouteFailure; reason: string };

/**
 * Score departments for a task, assign the winning agent, and fire dispatch.
 *
 * Assigns the agent ONLY — status stays `backlog`. `autoDispatchTask` is the
 * single authority that flips backlog → in_progress, and only AFTER chat.send
 * actually reaches the specialist (see task-dispatcher.ts). The previous code
 * pre-set `in_progress` here, which tripped autoDispatchTask's SKIP_STATUSES
 * guard so the agent was never invoked while the card read "In Progress"
 * (G8-KANBAN). If dispatch aborts — gateway down, sovereignty hold, SOP hold —
 * the task stays assigned-in-backlog and the backlog-redispatch sweep rescues it.
 *
 * Never throws for an absent task or an unroutable one: both are ordinary
 * outcomes the caller reports. A DB or router fault still propagates.
 */
export async function autoRouteTask(
  taskId: string,
  workspaceId?: string | null,
): Promise<AutoRouteResult> {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    return { routed: false, taskId, failure: 'task-not-found', reason: `Task not found: ${taskId}` };
  }

  const result = await routeTask({
    title: task.title,
    description: task.description || '',
    priority: task.priority,
    workspace_id: workspaceId || task.workspace_id || 'default',
    department: task.department,
  });

  if (!result) {
    return {
      routed: false,
      taskId,
      failure: 'no-agent-available',
      reason: 'No suitable agent available for this task',
    };
  }

  run(`UPDATE tasks SET assigned_agent_id = ?, updated_at = ? WHERE id = ?`, [
    result.agentId,
    new Date().toISOString(),
    taskId,
  ]);

  console.log(
    `[AutoRoute] Task "${task.title}" (${taskId}) assigned to ${result.agentName} via ${result.department} → backlog (awaiting auto-dispatch)`,
  );

  // W5.2 — ASSIGNMENT owner notification. Best-effort; never rolls back the row.
  try {
    notifyOwnerAssigned(taskId, { department: result.department });
  } catch {
    /* non-fatal */
  }

  // AUTO-DISPATCH: fire the OpenClaw invocation immediately. Fire-and-forget so
  // the caller is not blocked by gateway latency. The import is DEFERRED because
  // task-dispatcher.ts imports qc-scorer.ts, which imports this module — a static
  // import here would close that cycle at module-init time.
  try {
    const { autoDispatchTask } = await import('@/lib/task-dispatcher');
    void autoDispatchTask(taskId, 'auto-route');
  } catch (err) {
    console.warn('[AutoRoute] auto-dispatch could not be started (non-fatal):', (err as Error).message);
  }

  return {
    routed: true,
    taskId,
    agentId: result.agentId,
    agentName: result.agentName,
    department: result.department,
    score: result.score,
    reason: result.reason,
  };
}
