/**
 * Intake-advance sweep (W8.1 — the consumer the board always lacked).
 *
 * THE PROBLEM IT KILLS:
 *   `inbox` (and the other intake lanes) were terminal dead-ends. 183 of 188
 *   live tasks sat frozen because NO job ever selected an intake-lane task and
 *   pushed it onward — there was no consumer. Meanwhile the backlog/CEO sweeps
 *   re-fired dispatch every 2-5 min against tasks that could not advance (the
 *   token furnace). "Nothing sticks" is the one live test, and everything stuck.
 *
 * WHAT THIS IS:
 *   The SINGLE advancement authority. Every tick it selects all non-terminal,
 *   non-in-flight tasks (inbox / backlog / planning / pending_dispatch /
 *   assigned), and for each:
 *     • if UNASSIGNED → routes it (routeTask across all departments) and stamps
 *       the winning agent + department, UNLESS it scores to the CEO/COM master
 *       (left for a human exec decision — the CEO is a dispatcher, not a worker);
 *     • attaches it to its department's live campaign board (W8.4 feed);
 *     • fires autoDispatchTask, which advances it backlog→in_progress once the
 *       specialist actually starts.
 *
 * WHY IT CAN NEVER FURNACE:
 *   It selects ONLY tasks that are (a) under the QC re-route cap, (b) under the
 *   dispatch attempt cap, and (c) past their exponential-backoff window
 *   (next_dispatch_eligible_at). autoDispatchTask records every failed advance
 *   (gateway down / sovereignty / no-runtime), backs off, and BLOCKS after N —
 *   so an unadvanceable task drops out of this selection instead of being
 *   re-fired forever. A 120s grace window + a batch cap prevent a storm and
 *   double-dispatch of a just-created/just-assigned task.
 *
 * IDEMPOTENT: autoDispatchTask self-skips (GUARD 3 SKIP_STATUSES + GUARD 6
 * backoff) the instant a task advances, so re-selecting it is a cheap no-op.
 *
 * Disable with INTAKE_ADVANCE_SWEEP_ENABLED=0.
 */

import { queryAll, run, queryOne } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import { routeTask } from '@/lib/routing/department-router';
import { ensureCampaignForTask } from '@/lib/campaigns';
import { QC_MAX_REROUTES } from '@/lib/qc-scorer';
import { v4 as uuidv4 } from 'uuid';
import type { Task, TaskPriority } from '@/lib/types';

// Intake lanes this worker drains. Excludes in-flight/terminal statuses
// (in_progress, testing, review, done, blocked, archived) — those are owned by
// the execution / QC paths, not advancement.
const ADVANCEABLE_STATUSES = ['inbox', 'backlog', 'planning', 'pending_dispatch', 'assigned'];

// Minimum routing score to auto-assign an UNASSIGNED task off the intake lane.
// Below this we leave it unassigned for human triage (mirrors ceo-delegation).
const ROUTE_MIN_SCORE = parseFloat(process.env.INTAKE_ROUTE_MIN_SCORE || '1');

export interface IntakeAdvanceResult {
  scanned: number;
  routed: number;
  dispatched: number;
  skippedReason?: string;
}

interface IntakeTaskRow {
  id: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  status: string;
  department: string | null;
  workspace_id: string | null;
  assigned_agent_id: string | null;
  campaign_id: string | null;
}

export async function runIntakeAdvanceSweep(): Promise<IntakeAdvanceResult> {
  if (
    process.env.INTAKE_ADVANCE_SWEEP_ENABLED === '0' ||
    process.env.INTAKE_ADVANCE_SWEEP_ENABLED === 'false'
  ) {
    return { scanned: 0, routed: 0, dispatched: 0, skippedReason: 'INTAKE_ADVANCE_SWEEP_ENABLED=0' };
  }

  const cap = parseInt(process.env.QC_MAX_REROUTES || String(QC_MAX_REROUTES), 10);
  const dispatchCap = Math.max(1, parseInt(process.env.MAX_DISPATCH_ATTEMPTS || '5', 10));
  const batch = parseInt(process.env.INTAKE_ADVANCE_BATCH || '25', 10);
  const graceSeconds = parseInt(process.env.INTAKE_ADVANCE_GRACE_SECONDS || '120', 10);
  const now = new Date().toISOString();
  const graceCutoff = new Date(Date.now() - graceSeconds * 1000).toISOString();
  const placeholders = ADVANCEABLE_STATUSES.map(() => '?').join(',');

  let rows: IntakeTaskRow[];
  try {
    rows = queryAll<IntakeTaskRow>(
      `SELECT t.id, t.title, t.description, t.priority, t.status,
              t.department, t.workspace_id, t.assigned_agent_id, t.campaign_id
         FROM tasks t
         LEFT JOIN agents a ON t.assigned_agent_id = a.id
        WHERE t.status IN (${placeholders})
          AND t.archived_at IS NULL
          AND (t.qc_reroute_attempts IS NULL OR t.qc_reroute_attempts < ?)
          AND (t.dispatch_attempts IS NULL OR t.dispatch_attempts < ?)
          AND (t.next_dispatch_eligible_at IS NULL OR t.next_dispatch_eligible_at <= ?)
          AND (t.assigned_agent_id IS NULL OR a.is_master IS NULL OR a.is_master = 0)
          AND (t.sop_authoring_for_task_id IS NULL)
          AND t.updated_at <= ?
        ORDER BY t.updated_at ASC
        LIMIT ?`,
      [...ADVANCEABLE_STATUSES, cap, dispatchCap, now, graceCutoff, batch],
    );
  } catch (err) {
    // Pre-migration DB (attempt-accounting columns absent) — skip cleanly.
    return { scanned: 0, routed: 0, dispatched: 0, skippedReason: `query failed: ${(err as Error).message}` };
  }

  if (rows.length === 0) {
    return { scanned: 0, routed: 0, dispatched: 0 };
  }

  let routed = 0;
  let dispatched = 0;

  for (const task of rows) {
    try {
      let agentId = task.assigned_agent_id;
      let department = task.department;

      // ── Route UNASSIGNED intake-lane tasks ────────────────────────────────
      if (!agentId) {
        const routing = await routeTask({
          title: task.title,
          description: task.description || '',
          priority: task.priority,
          workspace_id: null, // consider all departments
          department: task.department || undefined,
        });

        // No route, low confidence, or a CEO/COM master result → leave it
        // unassigned for a human exec decision (do NOT churn the board).
        if (!routing || routing.score < ROUTE_MIN_SCORE) continue;
        if (/ceo|com/i.test(routing.department)) continue;

        agentId = routing.agentId;
        department = routing.department || department;

        run(
          `UPDATE tasks SET assigned_agent_id = ?, department = ?, updated_at = ? WHERE id = ?`,
          [agentId, department, now, task.id],
        );
        run(
          `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [uuidv4(), 'task_dispatched', agentId, task.id, `Intake-advance routed: ${routing.reason}`, now],
        );
        routed++;
      }

      // ── Feed the campaign board (W8.4) ────────────────────────────────────
      if (!task.campaign_id) {
        ensureCampaignForTask(task.id, {
          workspaceId: task.workspace_id,
          department,
          title: task.title,
        });
      }

      // ── Advance: fire the specialist invocation ───────────────────────────
      // autoDispatchTask is fire-and-forget internally, idempotent against
      // status (GUARD 3) and backoff (GUARD 6), and never throws.
      await autoDispatchTask(task.id, 'intake-advance-sweep');
      dispatched++;

      // Broadcast the (possibly) updated row so the board reflects the move.
      try {
        const updated = queryOne<Task>(
          `SELECT t.*, aa.name as assigned_agent_name, aa.avatar_emoji as assigned_agent_emoji
             FROM tasks t LEFT JOIN agents aa ON t.assigned_agent_id = aa.id WHERE t.id = ?`,
          [task.id],
        );
        if (updated) broadcast({ type: 'task_updated', payload: updated });
      } catch { /* broadcast best-effort */ }
    } catch (err) {
      // Never let one task abort the sweep.
      console.warn(`[intake-advance] advance failed for task ${task.id}:`, (err as Error).message);
    }
  }

  return { scanned: rows.length, routed, dispatched };
}
