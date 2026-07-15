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

import { queryAll, run, queryOne, sqlTime, timeNow } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { notifySystem } from '@/lib/notify';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import { routeTask } from '@/lib/routing/department-router';
import { ensureCampaignForTask } from '@/lib/campaigns';
import { QC_MAX_REROUTES } from '@/lib/qc-scorer';
import { healPhantomAssignmentsBatch } from '@/lib/jobs/heal-phantom-assignments';
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
  /** B6: tasks surfaced to the operator this tick for hitting the QC-reroute cap
   *  (fires exactly once per task via the `task_capped` event dedup). */
  capped?: number;
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
  const now = timeNow();
  const graceCutoff = new Date(Date.now() - graceSeconds * 1000).toISOString();
  const placeholders = ADVANCEABLE_STATUSES.map(() => '?').join(',');

  // ── C-04 (skill6-v2 U35): phantom-assignment healer, sweep-tail ─────────────
  // A phantom `assigned_agent_id` (references a nonexistent `agents` row) can
  // be introduced AFTER C-03 ships — raw SQL, a restored backup, or a
  // foreign-keys-off migration window (db/migrations.ts). Heal any such row
  // within the advanceable-status scope BEFORE this tick's selection query
  // runs below, so a freshly-injected phantom is un-assigned — and therefore
  // routed by the `!agentId` branch further down — within THIS SAME tick,
  // not only at the next one. Shares the exact healing primitive (and event
  // vocabulary: type 'phantom_agent_healed', reason 'assigned_agent_missing')
  // that autoDispatchTask's own real-time catch uses (task-dispatcher.ts,
  // C-03) — see src/lib/jobs/heal-phantom-assignments.ts. Never fatal: a
  // pre-migration DB (no events table) is tolerated exactly like every other
  // sweep in this file.
  try {
    healPhantomAssignmentsBatch({ healedBy: 'intake-advance-sweep', statuses: ADVANCEABLE_STATUSES });
  } catch (err) {
    console.warn('[intake-advance] phantom-assignment heal pass failed (non-fatal):', (err as Error).message);
  }

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
          AND (t.next_dispatch_eligible_at IS NULL OR ${sqlTime('t.next_dispatch_eligible_at')} <= ${sqlTime('?')})
          AND (t.assigned_agent_id IS NULL OR a.is_master IS NULL OR a.is_master = 0)
          AND (t.sop_authoring_for_task_id IS NULL)
          AND ${sqlTime('t.updated_at')} <= ${sqlTime('?')}
        ORDER BY t.updated_at ASC
        LIMIT ?`,
      [...ADVANCEABLE_STATUSES, cap, dispatchCap, now, graceCutoff, batch],
    );
  } catch (err) {
    // Pre-migration DB (attempt-accounting columns absent) — skip cleanly.
    return { scanned: 0, routed: 0, dispatched: 0, skippedReason: `query failed: ${(err as Error).message}` };
  }

  // NOTE: do NOT early-return on an empty advanceable set — the B6 cap-out
  // surfacing below must still run (capped tasks are, by construction, excluded
  // from `rows`). The loop is a no-op on an empty set.
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

  // ── B6: cap-out surfacing (silent-rot fix) ──────────────────────────────────
  // A task that hit the QC-reroute cap (qc_reroute_attempts >= cap) is silently
  // filtered out of the advanceable selection above and then rots invisibly in
  // backlog forever — the "silent cap-out rot" half of the review-churn defect.
  // Surface each capped task to the OPERATOR exactly once: write a `task_capped`
  // event (whose presence is the dedup key, so the NOT EXISTS guard fires the
  // alert a single time per task) and one SYSTEM-audience alert. NEVER a client
  // Telegram (MOVE-IN-SILENCE) — a capped task is an operator triage concern.
  let capped = 0;
  try {
    const cappedRows = queryAll<{ id: string; title: string; qc_reroute_attempts: number | null }>(
      `SELECT t.id, t.title, t.qc_reroute_attempts
         FROM tasks t
        WHERE t.status IN (${placeholders})
          AND t.archived_at IS NULL
          AND t.qc_reroute_attempts IS NOT NULL
          AND t.qc_reroute_attempts >= ?
          AND (t.sop_authoring_for_task_id IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'task_capped'
          )
        LIMIT 50`,
      [...ADVANCEABLE_STATUSES, cap],
    );
    for (const t of cappedRows) {
      try {
        run(
          `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'task_capped', ?, ?, ?)`,
          [
            uuidv4(),
            t.id,
            `[CAP] Task "${t.title}" reached the QC-reroute cap (${t.qc_reroute_attempts ?? cap}/${cap}) — ` +
              `held for operator review; auto-advancement stopped.`,
            now,
          ],
        );
        notifySystem(
          `[qc-cap] Task "${t.title}" (id ${t.id}) hit the QC-reroute cap ` +
            `(${t.qc_reroute_attempts ?? cap}/${cap}) and can no longer auto-advance. ` +
            `It is held for operator triage (promote, re-scope, or close).`,
          { agent: 'intake-advance-sweep', action: 'escalate' },
        );
        capped++;
      } catch (err) {
        console.warn(`[intake-advance] cap surfacing failed for ${t.id}:`, (err as Error).message);
      }
    }
  } catch (err) {
    // Pre-migration DB (no qc_reroute_attempts / events table) — non-fatal.
    console.warn('[intake-advance] cap-out query failed (non-fatal):', (err as Error).message);
  }

  return { scanned: rows.length, routed, dispatched, capped };
}
