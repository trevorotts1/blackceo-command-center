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

import { latestExecution } from '@/lib/execution-attempts';
import { isOwnerKilled } from '@/lib/owner-killed';
import { throwIfJobLeaseLost } from './job-lease';
import path from 'path';
import { safeReaddirSync, safeStatSync } from '@/lib/fs/safe-fs';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { transition, TransitionError, recordStatusEvent } from '@/lib/task-lifecycle';
import { getProjectsPath } from '@/lib/config';
import { EVIDENCE_DELIVERABLE_TYPES } from '@/lib/completion-evidence';
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

/** True when `dir` exists and holds at least one non-empty file that is not a
 * BLOCKED note (shallow, depth-limited so a huge tree can't stall the sweep).
 * Never throws. FIX 46: a run dir holding only e.g. P4-RENDER-BLOCKED.md is
 * NOT finished output — the file that marks the failure must not recover the
 * card, so BLOCK-named files are skipped at every depth. */
export function dirHasOutput(dir: string, depth = 2): boolean {
  if (!dir) return false;
  // safeReaddirSync NEVER blocks the sweep's event loop: PROJECTS_PATH may be
  // ~/Documents/Shared/projects (TCC-protected), where a raw opendir would hang
  // the whole process. On a protected/network dir the opendir runs in a hard-
  // timeout child and returns [] instead of freezing this every-5-minute cron.
  const entries = safeReaddirSync(dir);
  for (const e of entries) {
    if (e.isFile()) {
      if (isBlockedNotePath(e.name)) continue;
      const full = path.join(dir, e.name);
      const st = safeStatSync(full);
      if (st && st.size > 0) return true;
    } else if (e.isDirectory() && depth > 0) {
      const full = path.join(dir, e.name);
      if (dirHasOutput(full, depth - 1)) return true;
    }
  }
  return false;
}

/**
 * FIX 46 — a BLOCKED note is not finished work.
 *
 * When a phase fails (e.g. P4-RENDER), the deck engine writes a blocker note
 * such as `P4-RENDER-BLOCKED.md` into the run dir. A stalled `in_progress`
 * card whose ONLY output is such a note has NOT finished anything — it is a
 * failure record. The recovery gate used to see those bytes, "recover" the
 * card to review, and QC then graded a blocker note as if it were a deck.
 * A card blocked this way must be BLOCKED by the sweep, not recovered.
 *
 * Two exclusions, applied to both finished-work signals:
 *   1. Paths whose basename contains `BLOCK` (P4-RENDER-BLOCKED.md,
 *      RENDER-BLOCKED.txt, ...) are never evidence of finished output.
 *      Matched case-sensitively on the filename, at every tree depth, so a
 *      blocker note anywhere under the project dir stops the dir qualifying.
 *   2. Registered deliverables of a non-evidence type are not counted. The
 *      one canon of evidence types is completion-evidence.ts's
 *      EVIDENCE_DELIVERABLE_TYPES ('file' | 'artifact' | 'image' | 'url');
 *      a note/other-type row must not pass the recovery gate.
 */

/** Basename fragment that marks a file as a failure/blocker note, not output.
 * Case-sensitive 'BLOCK' matches the deck engine's `-BLOCKED.md` convention
 * (e.g. P4-RENDER-BLOCKED.md) without eating legit output names. */
export const BLOCKED_NOTE_MARKER = 'BLOCK';

export function isBlockedNotePath(p: string): boolean {
  return path.basename(p).includes(BLOCKED_NOTE_MARKER);
}

/** Deliverable types that count as finished work — the single canon imported
 * from completion-evidence.ts so this gate can never drift from the done-gate
 * that QC actually enforces. */
const RECOVERABLE_DELIVERABLE_TYPES = EVIDENCE_DELIVERABLE_TYPES;

/** Count registered deliverables of an evidence-bearing type (a late
 * write-back that DID land). Non-evidence types (e.g. 'note') do not count
 * (FIX 46). Tolerant of a pre-migration DB (table absent). */
export function countRegisteredDeliverables(taskId: string): number {
  try {
    const rows = queryAll<{ deliverable_type: string }>(
      'SELECT deliverable_type FROM task_deliverables WHERE task_id = ?',
      [taskId],
    );
    return rows.filter((r) => RECOVERABLE_DELIVERABLE_TYPES.has(r.deliverable_type)).length;
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
  throwIfJobLeaseLost();
  // New executions recover only from their unique callback/session evidence.
  // Generic files or a previous attempt's deliverables cannot prove this run finished.
  const current=queryOne<{killed_at:string|null;archived_at:string|null;description:string|null}>('SELECT killed_at,archived_at,description FROM tasks WHERE id=?',[task.id]);
  if(!current || current.archived_at || isOwnerKilled(current).killed || latestExecution(task.id)) return false;
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
    // MR-12: exempt from the review-column WIP limit — recovered finished work
    // must reach QC even when the column is full (else it would fall through to
    // the raw-write fallback purely because the column is capped).
    await transition(task.id, 'review', { actor, reason: recoverReason, operatorOverride: true });
  } catch (err) {
    if (err instanceof TransitionError) {
      // U99-RAW-STATUS-WRITER: fallback-of-last-resort for when transition()
      // itself rejects the edge (e.g. a concurrent writer already moved the
      // row); compound with last_progress_at so the stale sweep's own
      // no-progress clock resets on recovery. Audited via recordStatusEvent
      // immediately below, gated on the CAS actually landing.
      const fallbackRes = run(
        `UPDATE tasks SET status='review', updated_at=?, last_progress_at=? WHERE id=? AND status='in_progress'`,
        [now, now, task.id],
      );
      if ((fallbackRes.changes ?? 0) > 0) {
        recordStatusEvent(task.id, 'in_progress', 'review', { actor, reason: recoverReason });
      }
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
