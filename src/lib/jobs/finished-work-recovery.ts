/**
 * finished-work-recovery — the shared "don't block/bounce FINISHED work" gate.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * A dispatched agent can FINISH its work (deck / site / asset written to disk)
 * and then have its write-back 401 on a missing/wrong MC_API_TOKEN (the
 * "carded-but-trapped" defect). The card never leaves `in_progress`, so it is
 * later swept — by BOTH the stuck-in-progress sweep (→ `blocked`) and the
 * stale-task sweep (→ `backlog`). Either way, finished work is thrown away.
 *
 * This module is the ONE canonical recovery check both sweeps call BEFORE they
 * block/bounce a stalled `in_progress` task. Two finished-work signals:
 *   1. a deliverable already registered (a late write-back that DID land), or
 *   2. output files on disk the 401'd write-back never registered — probed at
 *      BOTH dispatch conventions (the manual project dir + the artifact dir).
 * On either signal we RECOVER the card to `review` (redelivering the on-disk
 * output as a deliverable when the 401 lost it) so QC can grade it, instead of
 * discarding it. Only a genuinely-empty stalled task is left for the caller to
 * block/bounce.
 */

import path from 'path';
import { safeReaddirSync, safeStatSync } from '@/lib/fs/safe-fs';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { transition, TransitionError } from '@/lib/task-lifecycle';
import { getProjectsPath } from '@/lib/config';
import { v4 as uuidv4 } from 'uuid';
import type { Task } from '@/lib/types';

/** Minimal shape both StuckRow and StaleTaskRow satisfy. */
export interface RecoverableTask {
  id: string;
  title: string;
  assigned_agent_id: string | null;
}

/** Slug the manual dispatch route uses to derive a task's on-disk project dir
 * (src/app/api/tasks/[id]/dispatch/route.ts: title → project dir). */
export function taskProjectSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** True when `dir` exists and holds at least one non-empty file (shallow, depth-
 * limited so a huge tree can't stall the sweep). Never throws. */
export function dirHasOutput(dir: string, depth = 2): boolean {
  if (!dir) return false;
  // safeReaddirSync NEVER blocks the sweep's event loop: PROJECTS_PATH may be
  // ~/Documents/Shared/projects (TCC-protected), where a raw opendir would hang
  // the whole process. On a protected/network dir the opendir runs in a hard-
  // timeout child and returns [] instead of freezing this every-5-minute cron.
  const entries = safeReaddirSync(dir);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile()) {
      const st = safeStatSync(full);
      if (st && st.size > 0) return true;
    } else if (e.isDirectory() && depth > 0) {
      if (dirHasOutput(full, depth - 1)) return true;
    }
  }
  return false;
}

/** Count non-discarded deliverables already registered for a task (a late
 * write-back that DID land). Tolerant of a pre-migration DB (table absent). */
export function countRegisteredDeliverables(taskId: string): number {
  try {
    const row = queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM task_deliverables WHERE task_id = ?',
      [taskId],
    );
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Read-only: the on-disk output dir for a task, or null when none is found. */
export function findOnDiskOutput(task: RecoverableTask): string | null {
  let projectsBase = '';
  try { projectsBase = getProjectsPath(); } catch { projectsBase = ''; }
  if (!projectsBase) return null;
  const candidates = [
    path.join(projectsBase, taskProjectSlug(task.title)), // manual dispatch dir
    path.join(projectsBase, 'artifacts', task.id),        // fast-loop artifact dir
  ];
  for (const dir of candidates) {
    if (dirHasOutput(dir)) return dir;
  }
  return null;
}

/**
 * If a stalled `in_progress` task actually FINISHED (registered deliverable OR
 * on-disk output), recover it to `review` (redelivering the on-disk output when
 * the 401 lost it) and return true. Return false when nothing finished — the
 * caller then blocks/bounces it. `actor` names the sweep for the audit trail.
 */
export async function recoverFinishedTaskToReview(
  task: RecoverableTask,
  actor: string,
): Promise<boolean> {
  const now = new Date().toISOString();

  // Signal 1 — a deliverable already registered is the strongest "it finished".
  const registered = countRegisteredDeliverables(task.id);

  // Signal 2 — on-disk output the 401'd deliverable write-back never registered.
  let recoveredPath: string | null = null;
  if (registered === 0) {
    recoveredPath = findOnDiskOutput(task);
    if (!recoveredPath) return false; // nothing finished — let the caller block.
  }

  // Redeliver the on-disk output as a deliverable when the 401 lost it.
  if (recoveredPath) {
    try {
      run(
        `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description)
         VALUES (?, ?, 'file', ?, ?, ?)`,
        [
          uuidv4(), task.id, 'Recovered output', recoveredPath,
          `Auto-registered by ${actor}: on-disk output found for a stalled ` +
          'in_progress task whose write-back had failed (likely MC_API_TOKEN 401).',
        ],
      );
    } catch (err) {
      console.warn(`[${actor}] recover: deliverable register skipped for ${task.id}:`, (err as Error).message);
    }
  }

  // Advance the card to review (audited) so the QC sweep grades it. Fall back to
  // a raw review write if the transition is rejected, so finished work is never
  // left stuck.
  const recoverReason = recoveredPath
    ? `Recovered: finished output found on disk (${recoveredPath}) for a stalled in_progress task — redelivered + advanced to review instead of blocking.`
    : `Recovered: ${registered} deliverable(s) already registered for a stalled in_progress task — advanced to review instead of blocking.`;
  try {
    await transition(task.id, 'review', { actor, reason: recoverReason });
  } catch (err) {
    if (err instanceof TransitionError) {
      run(
        `UPDATE tasks SET status='review', updated_at=?, last_progress_at=? WHERE id=? AND status='in_progress'`,
        [now, now, task.id],
      );
    } else {
      throw err;
    }
  }

  // Free the wedged agent, record the recovery, move the card on the board.
  if (task.assigned_agent_id) {
    run(
      `UPDATE agents SET status='standby', updated_at=? WHERE id=? AND status='working'`,
      [now, task.assigned_agent_id],
    );
  }
  try {
    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), 'task_recovered', task.assigned_agent_id, task.id, `[${actor}] ${recoverReason}`, now],
    );
  } catch { /* legacy events table — non-fatal */ }
  try {
    const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
    if (updated) broadcast({ type: 'task_updated', payload: updated });
  } catch { /* broadcast best-effort */ }

  console.warn(`[${actor}] task ${task.id} RECOVERED to review (finished work found; not blocked/bounced).`);
  return true;
}
