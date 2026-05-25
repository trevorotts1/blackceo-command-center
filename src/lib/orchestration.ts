/**
 * Orchestration Helper
 * 
 * This module provides helper functions for the master agent (orchestrator) to properly
 * log activities, deliverables, and manage sub-agent sessions when orchestrating tasks.
 * 
 * Usage:
 * - Log activities as sub-agents work
 * - Track deliverables created
 * - Register sub-agent sessions
 * - Verify review completion before approval
 */

import { getMissionControlUrl } from './config';

const MISSION_CONTROL_URL = getMissionControlUrl();

// ===========================================================================
// Agent status transitions (PRD Section 3.13)
// ===========================================================================
//
// Transition rules:
//   - Move to `busy` when:
//       * pending tasks for the agent > BUSY_PENDING_TASKS (default 5), OR
//       * avg task duration > 2x the agent's baseline.
//   - Move to `degraded` when:
//       * 3+ consecutive task failures, OR
//       * a provider API returning HTTP 429 or 5xx for this agent.
//
// These thresholds are intentionally simple defaults. Per-agent overrides
// live in the future agent_status_config table; until then the constants
// below are the configuration.

export type AgentStatus = 'standby' | 'working' | 'busy' | 'degraded' | 'offline';

export const BUSY_PENDING_TASKS = 5;
export const DEGRADED_CONSECUTIVE_FAILURES = 3;
export const DEGRADED_PROVIDER_HTTP_CODES = new Set([429, 500, 502, 503, 504]);
/** Multiplier on baseline avg task duration that triggers a busy flip. */
export const BUSY_DURATION_MULTIPLIER = 2;

export interface AgentLoadSnapshot {
  agentId: string;
  pendingTasks: number;
  /** Average duration of completed tasks in milliseconds, recent window. */
  avgTaskDurationMs: number;
  /** Baseline average duration in milliseconds. */
  baselineDurationMs: number;
  /** Number of consecutive failed tasks at the tail of the activity log. */
  consecutiveFailures: number;
  /** Last upstream provider HTTP status code observed (optional). */
  lastProviderHttpStatus?: number;
}

/**
 * Compute the next agent status from a load snapshot. Pure function — no DB
 * access — so callers can unit-test it and decide when to persist.
 *
 * Priority of states (worst wins):
 *   degraded > busy > working > standby
 *
 * Offline is only ever set by the operator or the gateway disconnect handler;
 * this function never returns `offline` so a snapshot-based check cannot
 * silently mark an agent unreachable.
 */
export function computeAgentStatus(snapshot: AgentLoadSnapshot): AgentStatus {
  const {
    pendingTasks,
    avgTaskDurationMs,
    baselineDurationMs,
    consecutiveFailures,
    lastProviderHttpStatus,
  } = snapshot;

  // Degraded conditions first.
  if (consecutiveFailures >= DEGRADED_CONSECUTIVE_FAILURES) return 'degraded';
  if (
    typeof lastProviderHttpStatus === 'number' &&
    DEGRADED_PROVIDER_HTTP_CODES.has(lastProviderHttpStatus)
  ) {
    return 'degraded';
  }

  // Busy conditions.
  if (pendingTasks > BUSY_PENDING_TASKS) return 'busy';
  if (
    baselineDurationMs > 0 &&
    avgTaskDurationMs > baselineDurationMs * BUSY_DURATION_MULTIPLIER
  ) {
    return 'busy';
  }

  if (pendingTasks > 0) return 'working';
  return 'standby';
}

/**
 * Apply the computed status to the agent row and log the transition to
 * task_activities (PRD 3.13: "Surface these transitions in `task_activities`
 * log so the Performance Board can show degradation history.").
 */
export async function evaluateAgentStatusFromDb(agentId: string): Promise<AgentStatus> {
  // Lazy import to avoid pulling better-sqlite3 into edge/client bundles
  // through this module's tree.
  const { queryOne, queryAll, run } = await import('./db');

  const agent = queryOne<{ id: string; status: AgentStatus }>(
    'SELECT id, status FROM agents WHERE id = ?',
    [agentId]
  );
  if (!agent) return 'offline';
  if (agent.status === 'offline') return 'offline';

  const pendingRow = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks
     WHERE assigned_agent_id = ?
       AND status NOT IN ('done', 'review')`,
    [agentId]
  );
  const pendingTasks = pendingRow?.n ?? 0;

  // Average duration of the agent's most recent 20 completed tasks in
  // milliseconds. Older completions form the baseline.
  const recentDurations = queryAll<{ duration_ms: number }>(
    `SELECT (julianday(updated_at) - julianday(created_at)) * 86400 * 1000 AS duration_ms
     FROM tasks
     WHERE assigned_agent_id = ?
       AND status = 'done'
     ORDER BY updated_at DESC
     LIMIT 20`,
    [agentId]
  );
  const baselineDurations = queryAll<{ duration_ms: number }>(
    `SELECT (julianday(updated_at) - julianday(created_at)) * 86400 * 1000 AS duration_ms
     FROM tasks
     WHERE assigned_agent_id = ?
       AND status = 'done'
     ORDER BY updated_at DESC
     LIMIT 100 OFFSET 20`,
    [agentId]
  );
  const avgTaskDurationMs = avg(recentDurations.map((r) => r.duration_ms));
  const baselineDurationMs = avg(baselineDurations.map((r) => r.duration_ms));

  // Consecutive failures: walk the agent's recent task_activities feed and
  // count tail failures before the first non-failure entry.
  let consecutiveFailures = 0;
  try {
    const activityTable = queryOne<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_activities'`,
      []
    );
    if (activityTable) {
      const tail = queryAll<{ activity_type: string }>(
        `SELECT activity_type FROM task_activities
         WHERE agent_id = ?
         ORDER BY created_at DESC
         LIMIT 10`,
        [agentId]
      );
      for (const row of tail) {
        if (row.activity_type === 'failed') consecutiveFailures += 1;
        else break;
      }
    }
  } catch {
    // Optional: task_activities may not exist in older test DBs.
  }

  const next = computeAgentStatus({
    agentId,
    pendingTasks,
    avgTaskDurationMs,
    baselineDurationMs,
    consecutiveFailures,
  });

  if (next !== agent.status) {
    run('UPDATE agents SET status = ?, updated_at = datetime("now") WHERE id = ?', [
      next,
      agentId,
    ]);

    // Best-effort transition log into task_activities. The Performance Board
    // reads from this table; the transition row links to the agent but has
    // no task_id (it is an agent-level event).
    try {
      run(
        `INSERT INTO task_activities (task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (NULL, ?, 'status_changed', ?, ?, datetime('now'))`,
        [
          agentId,
          `Agent status: ${agent.status} -> ${next}`,
          JSON.stringify({
            previous: agent.status,
            next,
            pendingTasks,
            avgTaskDurationMs,
            baselineDurationMs,
            consecutiveFailures,
          }),
        ]
      );
    } catch {
      // task_activities table may not have a nullable task_id in some envs;
      // suppress and continue. The status update itself is the source of truth.
    }
  }

  return next;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Record an upstream provider HTTP status for an agent. Triggers a fresh
 * status evaluation so a 429/5xx flips the agent to `degraded` immediately.
 */
export async function recordProviderResponseForAgent(
  agentId: string,
  httpStatus: number
): Promise<void> {
  if (!DEGRADED_PROVIDER_HTTP_CODES.has(httpStatus)) return;
  try {
    const { run } = await import('./db');
    run('UPDATE agents SET status = ?, updated_at = datetime("now") WHERE id = ?', [
      'degraded',
      agentId,
    ]);
  } catch (err) {
    console.error('[orchestration] recordProviderResponseForAgent failed:', err);
  }
}

export interface LogActivityParams {
  taskId: string;
  activityType: 'spawned' | 'updated' | 'completed' | 'file_created' | 'status_changed';
  message: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export interface LogDeliverableParams {
  taskId: string;
  deliverableType: 'file' | 'url' | 'artifact';
  title: string;
  path?: string;
  description?: string;
}

export interface RegisterSubAgentParams {
  taskId: string;
  sessionId: string;
  agentName?: string;
}

/**
 * Log an activity to a task's activity feed
 * This makes activities visible in the Command Center UI
 */
export async function logActivity(params: LogActivityParams): Promise<void> {
  try {
    const response = await fetch(`${MISSION_CONTROL_URL}/api/tasks/${params.taskId}/activities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activity_type: params.activityType,
        message: params.message,
        agent_id: params.agentId,
        metadata: params.metadata,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Failed to log activity: ${error}`);
    } else {
      console.log(`✓ Activity logged: ${params.message}`);
    }
  } catch (error) {
    console.error('Error logging activity:', error);
  }
}

/**
 * Log a deliverable (file, URL, or artifact) to a task
 * This makes deliverables visible in the Deliverables tab
 */
export async function logDeliverable(params: LogDeliverableParams): Promise<void> {
  try {
    const response = await fetch(`${MISSION_CONTROL_URL}/api/tasks/${params.taskId}/deliverables`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deliverable_type: params.deliverableType,
        title: params.title,
        path: params.path,
        description: params.description,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Failed to log deliverable: ${error}`);
    } else {
      console.log(`✓ Deliverable logged: ${params.title}`);
    }
  } catch (error) {
    console.error('Error logging deliverable:', error);
  }
}

/**
 * Register a sub-agent session in Command Center
 * This makes the session visible in the Sessions tab and updates agent counters
 */
export async function registerSubAgentSession(params: RegisterSubAgentParams): Promise<void> {
  try {
    const response = await fetch(`${MISSION_CONTROL_URL}/api/tasks/${params.taskId}/subagent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        openclaw_session_id: params.sessionId,
        agent_name: params.agentName,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Failed to register sub-agent session: ${error}`);
    } else {
      console.log(`✓ Sub-agent session registered: ${params.sessionId}`);
    }
  } catch (error) {
    console.error('Error registering sub-agent session:', error);
  }
}

/**
 * Mark a sub-agent session as completed
 * Updates the session status to 'completed' and sets ended_at timestamp
 */
export async function completeSubAgentSession(sessionId: string, summary?: string): Promise<void> {
  try {
    const response = await fetch(`${MISSION_CONTROL_URL}/api/openclaw/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'completed',
        ended_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Failed to complete sub-agent session: ${error}`);
    } else {
      console.log(`✓ Sub-agent session completed: ${sessionId}`);
    }
  } catch (error) {
    console.error('Error completing sub-agent session:', error);
  }
}

/**
 * Get deliverables for a task (for review verification)
 */
export async function getDeliverables(taskId: string): Promise<any[]> {
  try {
    const response = await fetch(`${MISSION_CONTROL_URL}/api/tasks/${taskId}/deliverables`);
    if (!response.ok) {
      throw new Error(`Failed to fetch deliverables: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching deliverables:', error);
    return [];
  }
}

/**
 * Verify that a task has deliverables before approving it
 * Returns true if task has at least one deliverable, false otherwise
 */
export async function verifyTaskHasDeliverables(taskId: string): Promise<boolean> {
  const deliverables = await getDeliverables(taskId);
  return deliverables.length > 0;
}

/**
 * Complete workflow: Log everything when spawning a sub-agent
 */
export async function onSubAgentSpawned(params: {
  taskId: string;
  sessionId: string;
  agentName: string;
  description?: string;
}): Promise<void> {
  await Promise.all([
    logActivity({
      taskId: params.taskId,
      activityType: 'spawned',
      message: `Sub-agent spawned: ${params.agentName}`,
      metadata: { sessionId: params.sessionId, description: params.description },
    }),
    registerSubAgentSession({
      taskId: params.taskId,
      sessionId: params.sessionId,
      agentName: params.agentName,
    }),
  ]);
}

/**
 * Complete workflow: Log everything when sub-agent completes
 */
export async function onSubAgentCompleted(params: {
  taskId: string;
  sessionId: string;
  agentName: string;
  summary: string;
  deliverables?: Array<{ type: 'file' | 'url' | 'artifact'; title: string; path?: string }>;
}): Promise<void> {
  const promises: Promise<void>[] = [
    logActivity({
      taskId: params.taskId,
      activityType: 'completed',
      message: `${params.agentName} completed: ${params.summary}`,
      metadata: { sessionId: params.sessionId },
    }),
    completeSubAgentSession(params.sessionId, params.summary),
  ];

  // Log all deliverables
  if (params.deliverables) {
    for (const deliverable of params.deliverables) {
      promises.push(
        logDeliverable({
          taskId: params.taskId,
          deliverableType: deliverable.type,
          title: deliverable.title,
          path: deliverable.path,
        })
      );
    }
  }

  await Promise.all(promises);
}

/**
 * Example usage:
 * 
 * ```typescript
 * import * as orchestrator from '@/lib/orchestration';
 * 
 * // When spawning a sub-agent:
 * await orchestrator.onSubAgentSpawned({
 *   taskId: 'task-123',
 *   sessionId: 'agent:main:subagent:abc123',
 *   agentName: 'mission-control-integration-fixes',
 *   description: 'Fix Mission Control real-time updates',
 * });
 * 
 * // During work:
 * await orchestrator.logActivity({
 *   taskId: 'task-123',
 *   activityType: 'updated',
 *   message: 'Fixed SSE broadcast in dispatch endpoint',
 * });
 * 
 * // When complete:
 * await orchestrator.onSubAgentCompleted({
 *   taskId: 'task-123',
 *   sessionId: 'agent:main:subagent:abc123',
 *   agentName: 'mission-control-integration-fixes',
 *   summary: 'All integration issues fixed and tested',
 *   deliverables: [
 *     { type: 'file', title: 'Updated dispatch route', path: 'src/app/api/tasks/[id]/dispatch/route.ts' },
 *     { type: 'file', title: 'Orchestration helper', path: 'src/lib/orchestration.ts' },
 *   ],
 * });
 * 
 * // Before approving (review -> done):
 * const hasDeliverables = await orchestrator.verifyTaskHasDeliverables('task-123');
 * if (!hasDeliverables) {
 *   console.log('⚠️ Task has no deliverables - cannot approve');
 *   return;
 * }
 * ```
 */
