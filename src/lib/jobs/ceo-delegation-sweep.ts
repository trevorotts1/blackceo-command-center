/**
 * CEO delegation sweep (B8 — OPTIONAL safety net).
 *
 * Inbound tasks are now routed by content IN-PROCESS at create time
 * (createTaskCore → routeTask), so most tasks never land unassigned on the CEO
 * in the first place. This sweep is the safety net for the residue: tasks that
 * were created before this fix shipped, created with routing disabled, or that
 * scored to the CEO/master only because no agents existed yet at create time.
 *
 * It periodically takes backlog/unassigned tasks sitting in the CEO workspace,
 * re-runs routeTask() across ALL departments, and re-homes any that score above
 * a confidence threshold into the matching department + agent (broadcasting
 * `task_updated` so the card moves). Tasks that don't clear the threshold stay
 * on the CEO for genuine human/exec decisions — that's the safe fallback, so
 * the CEO is a dispatcher, not a dumping ground.
 *
 * QC-fail re-dispatch (v4.12.0):
 * Also sweeps backlog tasks that have been kicked back by the QC scorer
 * (they have a `department` set and a `[QC-FAIL]` marker in description).
 * These tasks know their target department, so routeTask is run with the
 * original department hint to re-assign the right specialist.
 *
 * PAUSED BY DEFAULT (SWEEP-01): intake-advance-sweep now owns board
 * advancement (including CEO-stranded re-homing). This legacy safety net is
 * opt-in — it runs ONLY when CEO_DELEGATION_SWEEP_ENABLED=1 (or =true). Its
 * JOBS entry stays registered so re-enabling needs no code change.
 */

import { queryAll, run, queryOne } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { routeTask } from '@/lib/routing/department-router';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import { ensureCampaignForTask } from '@/lib/campaigns';
import { v4 as uuidv4 } from 'uuid';
import type { Task } from '@/lib/types';

// Minimum routing score required to re-home a task off the CEO. Below this we
// leave it on the CEO for a human exec decision.
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CEO_DELEGATION_MIN_SCORE || '1');

interface CeoTaskRow {
  id: string;
  title: string;
  description: string | null;
  priority: Task['priority'];
  workspace_id: string;
  department: string | null;
  /** Non-null when task was kicked back by QC scorer (has [QC-FAIL] marker). */
  qc_reroute_attempts: number | null;
}

export async function runCeoDelegationSweep(): Promise<void> {
  // SWEEP-01: PAUSED BY DEFAULT. Opt in per box with CEO_DELEGATION_SWEEP_ENABLED=1.
  // Previously this only skipped on an explicit =0, so it ran at default even
  // though the CHANGELOG claimed it stayed paused.
  if (
    process.env.CEO_DELEGATION_SWEEP_ENABLED !== '1' &&
    process.env.CEO_DELEGATION_SWEEP_ENABLED !== 'true'
  ) {
    return;
  }

  // W8.2 anti-furnace: never re-select a task that has hit the dispatch attempt
  // cap or is still inside its exponential-backoff window. Pairs with the same
  // guards in autoDispatchTask + the intake-advance/backlog sweeps.
  const dispatchCap = Math.max(1, parseInt(process.env.MAX_DISPATCH_ATTEMPTS || '5', 10));
  const nowIso = new Date().toISOString();

  // ── 1. CEO-workspace stranded tasks (original behavior) ─────────────────
  const ceoWorkspaceIds = (queryAll<{ id: string }>(
    `SELECT id FROM workspaces WHERE LOWER(slug) IN ('ceo','dept-ceo') OR id = 'dept-ceo' OR id = 'ceo'`
  )).map((w) => w.id);

  const ceoTasks: CeoTaskRow[] = [];
  if (ceoWorkspaceIds.length > 0) {
    const placeholders = ceoWorkspaceIds.map(() => '?').join(',');
    const rows = queryAll<CeoTaskRow>(
      `SELECT id, title, description, priority, workspace_id, department, qc_reroute_attempts
       FROM tasks
       WHERE workspace_id IN (${placeholders})
         AND status = 'backlog'
         AND assigned_agent_id IS NULL
         AND (dispatch_attempts IS NULL OR dispatch_attempts < ?)
         AND (next_dispatch_eligible_at IS NULL OR next_dispatch_eligible_at <= ?)`,
      [...ceoWorkspaceIds, dispatchCap, nowIso],
    );
    ceoTasks.push(...rows);
  }

  // ── 2. Returned and QC-fail backlog tasks from ANY department ─────────────
  // Covers two sources:
  //   (a) QC-fail tasks (original v4.12.0 addition): kicked back by the QC scorer.
  //   (b) Worker handback tasks (N36 / SOP-01): returned via the
  //       return-to-orchestrator endpoint (description contains '[HANDBACK' or
  //       '[STALE-RETURN'). These have qc_reroute_attempts > 0 and a structured
  //       problem note the re-router reads.
  //
  // Escalation cap: tasks with qc_reroute_attempts >= cap (default 3) are not
  // re-routed -- they already carry a task_escalated event. We skip them here
  // so they stay visible in Backlog for human triage and do not re-loop.
  const cap = parseInt(process.env.QC_MAX_REROUTES || '3', 10);
  const qcFailTasks = queryAll<CeoTaskRow>(
    `SELECT id, title, description, priority, workspace_id, department, qc_reroute_attempts
     FROM tasks
     WHERE status = 'backlog'
       AND qc_reroute_attempts > 0
       AND qc_reroute_attempts < ?
       AND archived_at IS NULL
       AND (dispatch_attempts IS NULL OR dispatch_attempts < ?)
       AND (next_dispatch_eligible_at IS NULL OR next_dispatch_eligible_at <= ?)`,
    [cap, dispatchCap, nowIso],
  );

  // Merge: de-duplicate by id (a CEO-workspace QC-fail task would appear in both).
  const seenIds = new Set<string>();
  const allTasks: CeoTaskRow[] = [];
  for (const t of [...ceoTasks, ...qcFailTasks]) {
    if (!seenIds.has(t.id)) {
      seenIds.add(t.id);
      allTasks.push(t);
    }
  }

  if (allTasks.length === 0) return;

  for (const task of allTasks) {
    try {
      const isQcFail = (task.qc_reroute_attempts ?? 0) > 0;

      // Route across ALL departments (workspace_id: null) so the task can be
      // delegated DOWN. For QC-fail tasks, pass the known department hint so
      // the router re-selects the right specialist.
      const routing = await routeTask({
        title: task.title,
        description: task.description || '',
        priority: task.priority,
        workspace_id: null,
        department: task.department || undefined,
      });

      if (!routing) {
        if (isQcFail) {
          console.warn(`[ceo-delegation] QC-fail re-dispatch: no route found for "${task.title}" (${task.id}) — stays in backlog`);
        }
        continue;
      }
      if (routing.score < CONFIDENCE_THRESHOLD) continue;
      if (!isQcFail && /ceo|com/i.test(routing.department)) continue; // CEO/COM — leave for human

      const now = new Date().toISOString();
      // G8-KANBAN fix: assign agent + department but LEAVE status at backlog.
      // Pre-setting status='in_progress' here tripped autoDispatchTask GUARD 3
      // (SKIP_STATUSES includes 'in_progress'), so the OpenClaw invocation below
      // returned before chat.send — card moved but the agent never ran.
      // autoDispatchTask is the sole authority for the backlog → in_progress flip
      // and only flips after chat.send succeeds (mirrors createTaskCore). If
      // dispatch aborts, the task stays assigned-in-backlog and the
      // backlog-redispatch sweep retries it.
      run(
        `UPDATE tasks SET assigned_agent_id = ?, department = ?, updated_at = ? WHERE id = ?`,
        [routing.agentId, routing.department, now, task.id],
      );
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'task_dispatched',
          routing.agentId,
          task.id,
          isQcFail
            ? `QC-fail re-dispatch (attempt ${task.qc_reroute_attempts}): ${routing.reason}`
            : `CEO delegation: ${routing.reason}`,
          now,
        ],
      );
      // W8.4: feed the re-homed card onto its department's campaign board.
      ensureCampaignForTask(task.id, {
        workspaceId: task.workspace_id,
        department: routing.department,
        title: task.title,
      });

      const updated = queryOne<Task>(
        `SELECT t.*, aa.name as assigned_agent_name, aa.avatar_emoji as assigned_agent_emoji
         FROM tasks t LEFT JOIN agents aa ON t.assigned_agent_id = aa.id WHERE t.id = ?`,
        [task.id],
      );
      if (updated) broadcast({ type: 'task_updated', payload: updated });
      console.log(
        `[ceo-delegation] ${isQcFail ? 'QC-fail re-dispatch' : 'Re-homed'} task ${task.id} ("${task.title}") → ${routing.agentName} (${routing.department})`,
      );

      // AUTO-DISPATCH (v4.14.0): fire OpenClaw invocation after re-homing.
      // Guards inside autoDispatchTask handle master/CEO skip + status checks.
      void autoDispatchTask(task.id, 'ceo-delegation-sweep');
    } catch (err) {
      console.warn(`[ceo-delegation] Sweep failed for task ${task.id}:`, (err as Error).message);
    }
  }
}
