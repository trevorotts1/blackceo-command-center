/**
 * owner-direct-continuation.ts — durable execution-preference + fenced auto-route commit (JEV-012).
 *
 * WHY THIS EXISTS (spec 1.1, ss 5.2/5.5)
 * --------------------------------------
 * `auto-route.ts` re-routed every QC-failed card through department classification
 * and overwrote `assigned_agent_id` with a bare `WHERE id = ?`. An owner-direct
 * ("you do it") or named-worker ("have Jordan do it") assignment therefore lost
 * its authorized executor on the first QC failure, and a concurrent owner edit,
 * kill/archive, or execution reservation could be silently overwritten — with an
 * assignment-success notice and a dispatch fired from the stale result.
 *
 * WHAT THIS IS
 * ------------
 * 1. A small durable table (`task_execution_preferences`) holding the authorized
 *    execution preference per task: `current_assistant` | `named_worker` |
 *    `normal_delegation`, plus the authorized executor and evidence. Written in
 *    the SAME transaction as the assignment it authorizes, so the two can never
 *    drift. Server-side rows only — caller text (`owner_direct=true` JSON, magic
 *    markers, quoted commands) is never consulted.
 * 2. A snapshot reader (`readAutoRouteSnapshot`) that loads the task row, its
 *    preference, kill/archive state, and live execution ownership BEFORE any
 *    routing call runs.
 * 3. A single-transaction fenced committer (`commitAutoRouteDecision`) that
 *    re-checks every fence (input/assignment revision, company/workspace, task
 *    status, kill/archive, active-or-unknown execution ownership) and writes the
 *    executor/department/workspace change together with its reason/evidence. A
 *    lost fence returns false and writes NOTHING — the caller then emits no
 *    notice and triggers no dispatch.
 *
 * OFFLINE + PRE-MIGRATION SAFE: stdlib `CREATE TABLE IF NOT EXISTS` runs inside
 * the commit transaction; a preference read on a box that never wrote one simply
 * yields `normal_delegation`. No network, no provider access.
 */

import { queryOne, run, transaction, timeNow } from '@/lib/db';
import { ACTIVE_EXECUTION_STATES_SQL } from '@/lib/execution-schema';
import { isOwnerKilled } from '@/lib/owner-killed';
import type { Agent, Task } from '@/lib/types';
import { v4 as uuidv4 } from 'uuid';

export type ExecutionPreference = 'current_assistant' | 'named_worker' | 'normal_delegation';

/** Durable marker shared by assignment writers and the auto-route reader. */
const OWNER_DIRECT_MARKER = '[owner-direct]';

/** Routing-result methods that carry an authorized owner-direct pin. */
export function isOwnerDirectRoutingReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(OWNER_DIRECT_MARKER);
}

/** Stamp a router reason with the owner-direct marker (idempotent). */
export function markOwnerDirectReason(reason: string): string {
  if (isOwnerDirectRoutingReason(reason)) return reason;
  return `${OWNER_DIRECT_MARKER} ${reason}`;
}

/** Engine-owned sources are never routed or re-routed by this path. */
const ENGINE_SOURCES = ['build_deck', 'build_deck_phase', 'podcast-engine'];

/** Additive table DDL. Runs inside the commit transaction; safe to re-run. */
const PREFERENCE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS task_execution_preferences (
  task_id TEXT PRIMARY KEY,
  preference TEXT NOT NULL CHECK(preference IN ('current_assistant','named_worker','normal_delegation')),
  executor_agent_id TEXT,
  evidence TEXT,
  policy_revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

export function ensurePreferenceTable(): void {
  run(PREFERENCE_TABLE_SQL, []);
}

export interface PreferenceRow {
  preference: ExecutionPreference;
  executorAgentId: string | null;
  evidence: string | null;
  policyRevision: number;
}

/** Read the durable preference. Null on a pre-migration box or an unmarked task. */
export function readExecutionPreference(taskId: string): PreferenceRow | null {
  try {
    const row = queryOne<{
      preference: string;
      executor_agent_id: string | null;
      evidence: string | null;
      policy_revision: number | null;
    }>('SELECT preference, executor_agent_id, evidence, policy_revision FROM task_execution_preferences WHERE task_id = ?', [taskId]);
    if (!row) return null;
    if (row.preference !== 'current_assistant' && row.preference !== 'named_worker' && row.preference !== 'normal_delegation') return null;
    return {
      preference: row.preference,
      executorAgentId: row.executor_agent_id,
      evidence: row.evidence,
      policyRevision: row.policy_revision ?? 1,
    };
  } catch {
    return null; // table absent or unreadable — caller treats as normal delegation
  }
}

/** Task-row columns the auto-route fence reads. Additive + nullable. */
export type AutoRouteTaskRow = Task & {
  assignment_version?: number | null;
  routing_reason?: string | null;
  routing_config_revision?: string | null;
  qc_reroute_attempts?: number | null;
  dispatch_attempts?: number | null;
  dispatch_hold?: number | null;
  persona_input_revision?: number | null;
};

export interface SnapshotExecutor {
  id: string;
  name: string;
  isMaster: boolean;
  status: string;
  workspaceId: string;
  companyId: string | null;
}

export interface AutoRouteSnapshot {
  taskId: string;
  title: string;
  status: string;
  priority: Task['priority'];
  department: string | null;
  workspaceId: string | null;
  assignedAgentId: string | null;
  assignmentVersion: number;
  updatedAt: string;
  routingReason: string | null;
  qcRerouteAttempts: number;
  dispatchHold: number;
  source: string | null;
  killed: boolean;
  archived: boolean;
  companyId: string | null;
  preference: ExecutionPreference;
  prefExecutorAgentId: string | null;
  prefPolicyRevision: number;
  activeExecution: { id: string; state: string } | null;
  executor: SnapshotExecutor | null;
}

/**
 * Load everything the continuation decision fences on, BEFORE routing.
 * Returns undefined only when the task row itself is absent.
 */
export function readAutoRouteSnapshot(taskId: string): AutoRouteSnapshot | undefined {
  const task = queryOne<AutoRouteTaskRow>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) return undefined;

  let companyId: string | null = null;
  let workspaceArchived = false;
  if (task.workspace_id) {
    try {
      const ws = queryOne<{ company_id: string | null; archived_at: string | null }>(
        'SELECT company_id, archived_at FROM workspaces WHERE id = ?', [task.workspace_id]);
      companyId = ws?.company_id ?? null;
      workspaceArchived = !!ws?.archived_at;
    } catch {
      companyId = null;
    }
  }

  const kill = isOwnerKilled({ killed_at: task.killed_at ?? null, description: task.description ?? null });

  let activeExecution: { id: string; state: string } | null = null;
  try {
    activeExecution = queryOne<{ id: string; state: string }>(
      `SELECT id, state FROM task_executions WHERE task_id = ? AND state IN ${ACTIVE_EXECUTION_STATES_SQL} LIMIT 1`,
      [taskId]) ?? null;
  } catch {
    activeExecution = null; // pre-migration box without the executions table
  }

  const pref = readExecutionPreference(taskId);
  const markerPinned = isOwnerDirectRoutingReason(task.routing_reason ?? null);
  // The durable preference row is authoritative; the `[owner-direct]` routing
  // marker is the compatibility signal for rows stamped before the table (or
  // whose row was cleared by a lifecycle trigger that preserves catch-all only).
  // Either one opts into the pinned path — but NEITHER is ever read from caller
  // text: both are server-side persisted state.
  const preference: ExecutionPreference = pref?.preference
    ?? (markerPinned ? 'named_worker' : 'normal_delegation');

  let executor: SnapshotExecutor | null = null;
  if (task.assigned_agent_id) {
    try {
      const agent = queryOne<Agent & { company_id?: string | null }>(
        `SELECT a.*, w.company_id FROM agents a LEFT JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = ?`,
        [task.assigned_agent_id]);
      if (agent) {
        executor = {
          id: agent.id,
          name: agent.name,
          isMaster: !!agent.is_master,
          status: agent.status,
          workspaceId: agent.workspace_id,
          companyId: (agent as { company_id?: string | null }).company_id ?? null,
        };
      }
    } catch {
      executor = null;
    }
  }

  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    department: task.department ?? null,
    workspaceId: task.workspace_id ?? null,
    assignedAgentId: task.assigned_agent_id ?? null,
    assignmentVersion: task.assignment_version ?? 0,
    updatedAt: task.updated_at,
    routingReason: task.routing_reason ?? null,
    qcRerouteAttempts: task.qc_reroute_attempts ?? 0,
    dispatchHold: task.dispatch_hold ?? 0,
    source: task.source ?? null,
    killed: kill.killed,
    archived: !!task.archived_at || workspaceArchived,
    companyId,
    preference,
    prefExecutorAgentId: pref?.executorAgentId ?? null,
    prefPolicyRevision: pref?.policyRevision ?? 1,
    activeExecution,
    executor,
  };
}

export interface AutoRouteCommit {
  agentId: string;
  agentName: string;
  department: string;
  workspaceId: string;
  companyId: string;
  reason: string;
  /** Durable preference to persist beside the assignment. */
  preference: ExecutionPreference;
  preferenceEvidence: string | null;
}

/**
 * Commit one executor/department/workspace change with its reason/evidence in a
 * SINGLE transaction, fenced against everything that may have moved while
 * routing awaited: assignment revision, company/workspace, status, kill/archive
 * (column AND text marker), dispatch hold, engine ownership, and any
 * active-or-unknown execution. Returns true on commit, false on ANY lost fence
 * — having written nothing. The caller must emit no notice and trigger no
 * dispatch on false.
 */
export function commitAutoRouteDecision(snapshot: AutoRouteSnapshot, commit: AutoRouteCommit): boolean {
  return transaction(() => {
    ensurePreferenceTable();
    const now = timeNow();

    const current = queryOne<AutoRouteTaskRow>('SELECT * FROM tasks WHERE id = ?', [snapshot.taskId]);
    if (!current) return false;
    // Ownership + revision fences: the row must be exactly what routing saw.
    if ((current.assignment_version ?? 0) !== snapshot.assignmentVersion) return false;
    if ((current.assigned_agent_id ?? null) !== snapshot.assignedAgentId) return false;
    if (current.status !== snapshot.status) return false;
    if ((current.workspace_id ?? null) !== snapshot.workspaceId) return false;
    if ((current.department ?? null) !== snapshot.department) return false;
    if ((current.routing_reason ?? null) !== snapshot.routingReason) return false;
    if (current.updated_at !== snapshot.updatedAt) return false;
    // Kill/archive fences (structured column AND owner text marker).
    if (current.killed_at) return false;
    if (current.archived_at) return false;
    if (isOwnerKilled({ killed_at: current.killed_at ?? null, description: current.description ?? null }).killed) return false;
    // Dispatch-hold and engine-ownership fences.
    if ((current.dispatch_hold ?? 0) !== snapshot.dispatchHold) return false;
    if (ENGINE_SOURCES.includes(String(current.source ?? '').trim().toLowerCase())) return false;
    // Company fence: the routed company must still own this task's workspace.
    if (snapshot.companyId && commit.companyId !== snapshot.companyId) return false;
    // Active-or-unknown execution fence: never reopen or steal a live attempt.
    // A reconciled (terminal) attempt clears this; the new reservation then mints
    // its own attempt ID through the existing reservation machinery.
    try {
      const live = queryOne<{ id: string }>(
        `SELECT id FROM task_executions WHERE task_id = ? AND state IN ${ACTIVE_EXECUTION_STATES_SQL} LIMIT 1`,
        [snapshot.taskId]);
      if (live) return false;
    } catch {
      // No executions table — nothing to fence on.
    }
    // Executor fence: the committed worker must be live, company-scoped, and —
    // for a master/CEO executor — explicitly owner-authorized (owner-direct) or
    // catch-all. A master must never be installed by ordinary reclassification.
    const worker = queryOne<{ id: string; status: string; is_master: number | boolean; workspace_id: string; company_id: string | null }>(
      `SELECT a.id, a.status, a.is_master, a.workspace_id, w.company_id FROM agents a
         LEFT JOIN workspaces w ON w.id = a.workspace_id
        WHERE a.id = ? AND a.workspace_id = ? AND w.archived_at IS NULL`,
      [commit.agentId, commit.workspaceId]);
    if (!worker || worker.status === 'offline') return false;
    if (snapshot.companyId && worker.company_id !== snapshot.companyId) return false;
    const workerIsMaster = !!worker.is_master;
    const ownerAuthorized = commit.preference !== 'normal_delegation' || isOwnerDirectRoutingReason(commit.reason);
    const catchAll = typeof commit.reason === 'string' && commit.reason.startsWith('[catch-all]');
    if (workerIsMaster && !ownerAuthorized && !catchAll) return false;

    const changed = run(
      `UPDATE tasks SET assigned_agent_id = ?, department = ?, workspace_id = ?,
        assignment_version = assignment_version + 1,
        routing_reason = ?, routing_wait_owner = NULL, routing_next_action = NULL,
        next_routing_eligible_at = NULL, updated_at = ?
       WHERE id = ? AND assignment_version = ? AND (assigned_agent_id IS ? OR assigned_agent_id = ?)
         AND status = ? AND (workspace_id IS ? OR workspace_id = ?)
         AND (routing_reason IS ? OR routing_reason = ?) AND updated_at = ?
         AND archived_at IS NULL AND killed_at IS NULL
         AND upper(COALESCE(description,'')) NOT LIKE '%OWNER KILLED%'`,
      [commit.agentId, commit.department, commit.workspaceId,
        commit.reason, now,
        snapshot.taskId, snapshot.assignmentVersion,
        snapshot.assignedAgentId, snapshot.assignedAgentId,
        snapshot.status, snapshot.workspaceId, snapshot.workspaceId,
        snapshot.routingReason, snapshot.routingReason, snapshot.updatedAt]);
    if (!changed.changes) return false;

    run(`INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?,?,?,?,?,?)`,
      [uuidv4(), 'task_assigned', commit.agentId, snapshot.taskId,
        `Auto-route routed: ${commit.reason}`, now]);
    const nextRevision = snapshot.prefPolicyRevision + 1;
    run(`INSERT INTO task_execution_preferences (task_id, preference, executor_agent_id, evidence, policy_revision, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET preference=excluded.preference, executor_agent_id=excluded.executor_agent_id,
           evidence=excluded.evidence, policy_revision=excluded.policy_revision, updated_at=excluded.updated_at`,
      [snapshot.taskId, commit.preference, commit.agentId, commit.preferenceEvidence, nextRevision, now, now]);
    return true;
  });
}
