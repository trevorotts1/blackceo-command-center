/**
 * Backlog re-dispatch sweep (G8-KANBAN — durable rescue net).
 *
 * PROBLEM (Cause B + Gap G):
 *   autoDispatchTask() fires exactly once — at create time (createTaskCore), at
 *   route time (auto-route), or at re-home time (ceo-delegation-sweep). If that
 *   single attempt aborts for a transient reason (OpenClaw gateway down, model
 *   sovereignty needs owner input, SOP authoring hold), the task is left
 *   ASSIGNED but still in `backlog`, with NO mechanism to retry. The card sits
 *   at the very front of the board with an agent on it and never moves —
 *   exactly the "cards never progress" failure this sweep exists to kill.
 *
 * FIX:
 *   Every couple of minutes, select tasks that are still `backlog`, already have
 *   an assigned specialist, and have not exhausted the QC re-route cap, then call
 *   autoDispatchTask() for each. autoDispatchTask is idempotent against status
 *   (GUARD 3 / SKIP_STATUSES) — the instant a task successfully flips to
 *   in_progress it drops out of this sweep's selection, so a task is only ever
 *   retried while it is genuinely stuck. No token is burned on the failing path
 *   (the OpenClaw connect / sovereignty / SOP-hold guards all return BEFORE any
 *   chat.send / LLM call), so a persistently-blocked task cannot become a
 *   token furnace — it just keeps cheaply retrying until the blocker clears.
 *
 * ANTI-FURNACE / ANTI-STORM guards (durable, no self-resurrect):
 *   1. Grace window: only tasks whose `updated_at` is older than
 *      BACKLOG_REDISPATCH_GRACE_SECONDS (default 120s) are eligible, so a task
 *      that was JUST assigned (and already had autoDispatchTask fired
 *      fire-and-forget by the assigning path) is not double-fired before its
 *      first attempt has had time to land. This is what prevents a re-dispatch
 *      storm and double agent-invocation.
 *   2. Batch cap: at most BACKLOG_REDISPATCH_BATCH (default 25) tasks per tick,
 *      oldest-first, dispatched sequentially (concurrency 1) so a slow gateway
 *      cannot fan out.
 *   3. Attempt cap: tasks at/over the QC re-route cap (QC_MAX_REROUTES) are
 *      skipped — those are already-escalated/blocked and must stay visible in
 *      Backlog for human triage, never re-looped.
 *   4. Master/CEO exclusion: tasks assigned to a master/CEO agent are skipped
 *      (autoDispatchTask would skip them anyway; excluding here stops them being
 *      re-selected every tick forever).
 *
 * Trivially disabled: set BACKLOG_REDISPATCH_SWEEP_ENABLED=0, or remove the one
 * JOBS entry in scheduler.ts.
 */

import { queryAll } from '@/lib/db';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import { QC_MAX_REROUTES } from '@/lib/qc-scorer';

export interface BacklogRedispatchResult {
  scanned: number;
  dispatched: number;
  skippedReason?: string;
}

interface BacklogTaskRow {
  id: string;
  qc_reroute_attempts: number | null;
}

export async function runBacklogRedispatchSweep(): Promise<BacklogRedispatchResult> {
  if (
    process.env.BACKLOG_REDISPATCH_SWEEP_ENABLED === '0' ||
    process.env.BACKLOG_REDISPATCH_SWEEP_ENABLED === 'false'
  ) {
    return { scanned: 0, dispatched: 0, skippedReason: 'BACKLOG_REDISPATCH_SWEEP_ENABLED=0' };
  }

  const cap = parseInt(process.env.QC_MAX_REROUTES || String(QC_MAX_REROUTES), 10);
  const batch = parseInt(process.env.BACKLOG_REDISPATCH_BATCH || '25', 10);
  const graceSeconds = parseInt(process.env.BACKLOG_REDISPATCH_GRACE_SECONDS || '120', 10);
  const graceCutoff = new Date(Date.now() - graceSeconds * 1000).toISOString();

  // Assigned, still-backlog, not-archived, under the re-route cap, not on a
  // master/CEO agent, and last touched before the grace window. Oldest first so
  // the most-stuck cards drain first.
  const rows = queryAll<BacklogTaskRow>(
    `SELECT t.id AS id, t.qc_reroute_attempts AS qc_reroute_attempts
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
      WHERE t.status = 'backlog'
        AND t.assigned_agent_id IS NOT NULL
        AND t.archived_at IS NULL
        AND (t.qc_reroute_attempts IS NULL OR t.qc_reroute_attempts < ?)
        AND (a.is_master IS NULL OR a.is_master = 0)
        AND t.updated_at <= ?
      ORDER BY t.updated_at ASC
      LIMIT ?`,
    [cap, graceCutoff, batch],
  );

  if (rows.length === 0) {
    return { scanned: 0, dispatched: 0 };
  }

  let dispatched = 0;
  for (const row of rows) {
    try {
      // Sequential (concurrency 1) so a slow gateway cannot fan out. autoDispatchTask
      // is fire-and-forget internally and never throws; it self-skips via GUARD 3 if
      // the task already advanced between SELECT and dispatch.
      await autoDispatchTask(row.id, 'backlog-redispatch-sweep');
      dispatched++;
    } catch (err) {
      // Defensive: autoDispatchTask should never throw, but never let one task
      // abort the sweep.
      console.warn(
        `[backlog-redispatch] re-dispatch failed for task ${row.id}:`,
        (err as Error).message,
      );
    }
  }

  return { scanned: rows.length, dispatched };
}
