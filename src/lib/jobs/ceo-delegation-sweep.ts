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
 * LOW-FREQUENCY and trivially disabled: remove the one JOBS entry in
 * scheduler.ts or set CEO_DELEGATION_SWEEP_ENABLED=0.
 */

import { queryAll, run, queryOne } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { routeTask } from '@/lib/routing/department-router';
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
}

export async function runCeoDelegationSweep(): Promise<void> {
  if (process.env.CEO_DELEGATION_SWEEP_ENABLED === '0') return;

  // CEO workspace is keyed by slug 'ceo' / id 'dept-ceo' (see migrations).
  const ceoWorkspaceIds = (queryAll<{ id: string }>(
    `SELECT id FROM workspaces WHERE LOWER(slug) IN ('ceo','dept-ceo') OR id = 'dept-ceo' OR id = 'ceo'`
  )).map((w) => w.id);

  if (ceoWorkspaceIds.length === 0) return;

  const placeholders = ceoWorkspaceIds.map(() => '?').join(',');
  const tasks = queryAll<CeoTaskRow>(
    `SELECT id, title, description, priority, workspace_id, department
     FROM tasks
     WHERE workspace_id IN (${placeholders})
       AND status IN ('backlog')
       AND (assigned_agent_id IS NULL)`,
    ceoWorkspaceIds
  );

  if (tasks.length === 0) return;

  for (const task of tasks) {
    try {
      // Route across ALL departments (workspace_id: null) so the task can be
      // delegated DOWN out of the CEO workspace.
      const routing = await routeTask({
        title: task.title,
        description: task.description || '',
        priority: task.priority,
        workspace_id: null,
        department: task.department || undefined,
      });

      // Only re-home on a confident, non-CEO match.
      if (!routing) continue;
      if (routing.score < CONFIDENCE_THRESHOLD) continue;
      if (/ceo|com/i.test(routing.department)) continue; // still a CEO/COM decision

      const now = new Date().toISOString();
      run(
        `UPDATE tasks SET assigned_agent_id = ?, department = ?, updated_at = ? WHERE id = ?`,
        [routing.agentId, routing.department, now, task.id]
      );
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), 'task_dispatched', routing.agentId, task.id, `CEO delegation: ${routing.reason}`, now]
      );
      const updated = queryOne<Task>(
        `SELECT t.*, aa.name as assigned_agent_name, aa.avatar_emoji as assigned_agent_emoji
         FROM tasks t LEFT JOIN agents aa ON t.assigned_agent_id = aa.id WHERE t.id = ?`,
        [task.id]
      );
      if (updated) broadcast({ type: 'task_updated', payload: updated });
      console.log(`[ceo-delegation] Re-homed task ${task.id} ("${task.title}") → ${routing.agentName} (${routing.department})`);
    } catch (err) {
      console.warn(`[ceo-delegation] Sweep failed for task ${task.id}:`, (err as Error).message);
    }
  }
}
