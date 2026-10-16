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
 * JEV-012 (spec 1.1, s 5.5) — the four fenced behaviors:
 *   1. The persisted execution preference, source authorization,
 *      assignment/input revisions, and current execution ownership are read
 *      (readAutoRouteSnapshot) BEFORE any routing call runs. An owner-direct
 *      (`current_assistant`) or named-worker assignment keeps its authorized
 *      executor through a QC failure; an unavailable pinned executor holds,
 *      never silently delegates. Authorization comes only from the durable
 *      preference row / server-side routing marker — never from caller text
 *      (`owner_direct=true` JSON, magic markers, quoted commands are intent
 *      evidence, not permission).
 *   2. The commit goes through the existing atomic primitive
 *      (commitAutoRouteDecision, which extends commitIntakeAssignment's
 *      version/ownership/execution fences with an explicit owner-direct
 *      master policy) — it is not assumed allowed, it is fenced.
 *   3. The commit is ONE transaction fenced against input/assignment revision,
 *      company/workspace, status, kill/archive, and active-or-unknown
 *      execution. A lost fence writes NOTHING: no assignment-success notice,
 *      no dispatch from the stale result.
 *   4. Task ID and execution-preference provenance are retained across the QC
 *      correction; a new attempt mints its own attempt ID through the existing
 *      reservation machinery (reserveExecution) after the old attempt is
 *      terminal — this function never reopens or steals a live attempt.
 *
 * SERVER-ONLY (touches the DB and the dispatcher).
 */

import { run, queryOne } from '@/lib/db';
import { routeTask } from '@/lib/routing/department-router';
import { notifyOwnerAssigned } from '@/lib/owner-reports';
import { QC_MAX_REROUTES } from '@/lib/qc-cap';
import {
  commitAutoRouteDecision,
  markOwnerDirectReason,
  readAutoRouteSnapshot,
} from '@/lib/routing/owner-direct-continuation';
import type { Task } from '@/lib/types';

/** Why a routing attempt produced no assignment. Maps 1:1 to the route's status codes. */
export type AutoRouteFailure =
  | 'task-not-found'
  | 'no-agent-available'
  | 'assignment-race'
  | 'executor-unavailable';

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

/** Seams the tests (and only the tests) substitute. Production always uses the defaults. */
export interface AutoRouteDeps {
  routeTask?: typeof routeTask;
  dispatch?: (taskId: string, context: string) => Promise<unknown>;
  notifyAssigned?: (taskId: string, overrides: { department: string }) => void;
}

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
 *
 * Ordering is load-bearing: snapshot (with all fences) → route (with the
 * persisted preference passed through) → single-transaction fenced commit →
 * notice + dispatch ONLY on commit. Anything that moves between the snapshot
 * and the commit loses the fence, writes nothing, and triggers nothing.
 */
export async function autoRouteTask(
  taskId: string,
  workspaceId?: string | null,
  deps: AutoRouteDeps = {},
): Promise<AutoRouteResult> {
  // ── (1) Read persisted preference, revisions, and ownership BEFORE routing ──
  const snapshot = readAutoRouteSnapshot(taskId);
  if (!snapshot) {
    return { routed: false, taskId, failure: 'task-not-found', reason: `Task not found: ${taskId}` };
  }

  // QC cap holds on this path too: a card at-or-over the cap is not claimable
  // (dispatcher GUARD 4 owns the same arithmetic; the scorer blocks itself —
  // this is the webhook/manual half).
  if (snapshot.qcRerouteAttempts >= QC_MAX_REROUTES) {
    return {
      routed: false,
      taskId,
      failure: 'no-agent-available',
      reason: `QC reroute cap reached (${snapshot.qcRerouteAttempts}/${QC_MAX_REROUTES}) — held for operator review`,
    };
  }

  // Kill/archive is terminal-for-dispatch (Rule R12): never route a dead card.
  if (snapshot.killed || snapshot.archived) {
    return {
      routed: false,
      taskId,
      failure: 'no-agent-available',
      reason: snapshot.killed
        ? 'Task was killed by the owner — re-route BLOCKED; task stays dead'
        : 'Task is archived — re-route BLOCKED',
    };
  }

  // Never reopen or steal a live/unknown attempt: the old attempt must reach
  // terminal/reconciled first (reservation machinery owns that). A reconciled
  // attempt clears this; the new reservation then mints its own attempt ID.
  if (snapshot.activeExecution) {
    return {
      routed: false,
      taskId,
      failure: 'executor-unavailable',
      reason: `Execution ${snapshot.activeExecution.id} is ${snapshot.activeExecution.state} — held until the attempt is terminal/reconciled`,
    };
  }

  // ── (2) Pass the persisted execution preference through to routing ─────────
  // The pinned executor comes from the durable preference row (or, for
  // pre-table rows, the server-side routing marker + current assignment) —
  // never from caller text. An owner pin resolves through the router's own
  // target_agent path so department classification is bypassed exactly as at
  // ingest; the result is then REQUIRED to be the pinned executor.
  const pinned = snapshot.preference !== 'normal_delegation';
  const pinnedExecutorId =
    snapshot.prefExecutorAgentId ?? (pinned ? snapshot.assignedAgentId : null);
  if (pinned && !pinnedExecutorId) {
    return {
      routed: false,
      taskId,
      failure: 'executor-unavailable',
      reason: `Execution preference ${snapshot.preference} is pinned but no authorized executor is recorded — held, never silently delegated`,
    };
  }
  if (
    pinned &&
    snapshot.executor &&
    snapshot.executor.id === pinnedExecutorId &&
    snapshot.executor.status === 'offline'
  ) {
    return {
      routed: false,
      taskId,
      failure: 'executor-unavailable',
      reason: `Pinned executor ${snapshot.executor.name} is offline — held, never silently delegated`,
    };
  }
  if (pinned && snapshot.executor && snapshot.executor.id !== pinnedExecutorId) {
    // The durable pin names an executor the roster no longer resolves to the
    // current assignment: hold rather than guess which one the owner meant.
    return {
      routed: false,
      taskId,
      failure: 'executor-unavailable',
      reason: 'Pinned executor does not match the current assignment — held for an explicit owner assignment',
    };
  }

  const descRow = queryOne<{ description: string | null }>(
    'SELECT description FROM tasks WHERE id = ?',
    [taskId],
  );
  const route = deps.routeTask ?? routeTask;
  const result = await route({
    title: snapshot.title,
    description: descRow?.description || '',
    priority: snapshot.priority,
    workspace_id: workspaceId || snapshot.workspaceId || 'default',
    department: snapshot.department ?? undefined,
    ...(pinnedExecutorId ? { target_agent: pinnedExecutorId } : {}),
  });

  if (!result) {
    return {
      routed: false,
      taskId,
      failure: 'no-agent-available',
      reason: pinned
        ? `Pinned executor ${pinnedExecutorId} could not be resolved — held, never silently delegated`
        : 'No suitable agent available for this task',
    };
  }

  // A pinned preference that resolves to anyone else is a refusal, not a
  // fallback: the router must not overwrite the authorized executor.
  if (pinned && result.agentId !== pinnedExecutorId) {
    return {
      routed: false,
      taskId,
      failure: 'executor-unavailable',
      reason: `Router resolved ${result.agentName} but the authorized executor is pinned — held, never overwritten`,
    };
  }

  // ── (3) Fenced single-transaction commit; stale writes nothing ─────────────
  const reason = pinned ? markOwnerDirectReason(result.reason) : result.reason;
  const committed = commitAutoRouteDecision(snapshot, {
    agentId: result.agentId,
    agentName: result.agentName,
    department: result.department,
    workspaceId: result.workspaceId ?? snapshot.workspaceId ?? 'default',
    companyId: result.companyId ?? snapshot.companyId ?? '',
    reason,
    preference: snapshot.preference,
    preferenceEvidence: snapshot.preference === 'normal_delegation' ? null : result.reason,
  });
  if (!committed) {
    // Lost fence (owner edit, kill/archive, another reservation, revision
    // drift): nothing was written — so no notice and no dispatch.
    return {
      routed: false,
      taskId,
      failure: 'assignment-race',
      reason: 'Assignment changed while routing awaited (owner edit, kill/archive, or another reservation won) — stale result discarded, nothing written',
    };
  }

  console.log(
    `[AutoRoute] Task "${snapshot.title}" (${taskId}) assigned to ${result.agentName} via ${result.department} → backlog (awaiting auto-dispatch)`,
  );

  // W5.2 — ASSIGNMENT owner notification. Best-effort; never rolls back the row.
  // Runs ONLY after the commit landed: a failed CAS emits no notice.
  try {
    (deps.notifyAssigned ?? notifyOwnerAssigned)(taskId, { department: result.department });
  } catch {
    /* non-fatal */
  }

  // AUTO-DISPATCH: fire the OpenClaw invocation immediately. Fire-and-forget so
  // the caller is not blocked by gateway latency. The import is DEFERRED because
  // task-dispatcher.ts imports qc-scorer.ts, which imports this module — a static
  // import here would close that cycle at module-init time. Fires ONLY after
  // the commit landed: never dispatch from a stale result.
  try {
    if (deps.dispatch) {
      void deps.dispatch(taskId, 'auto-route');
    } else {
      const { autoDispatchTask } = await import('@/lib/task-dispatcher');
      void autoDispatchTask(taskId, 'auto-route');
    }
  } catch (err) {
    console.warn('[AutoRoute] auto-dispatch could not be started (non-fatal):', (err as Error).message);
  }

  // The events table is append-only audit: readers must see the same row the
  // commit wrote, so this runs through the shared run() helper like every
  // other writer (never the raw better-sqlite3 handle).
  run(`UPDATE tasks SET updated_at = updated_at WHERE id = ?`, [taskId]);

  return {
    routed: true,
    taskId,
    agentId: result.agentId,
    agentName: result.agentName,
    department: result.department,
    score: result.score,
    reason,
  };
}
