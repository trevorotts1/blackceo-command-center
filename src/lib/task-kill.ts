/**
 * CANC-101 (finding 10) — kill-fence + live-notice helper.
 *
 * Cancel (POST /api/tasks/[id]/archive) and owner-update
 * (POST /api/tasks/[id]/messages) both need the same lookup: the task's
 * in-flight execution row, whose `session_key` (task_executions.session_key,
 * execution-schema.ts — NOT NULL UNIQUE, written at reservation time) is the
 * DURABLE handle for reaching the live run. One helper so the two routes
 * cannot drift.
 *
 * DELIVERY PRIMITIVE: `chat.send { sessionKey, message }` — the same call the
 * dispatch route uses (dispatch/route.ts). There is NO abort/stop RPC anywhere
 * in src/ (sweep: sessions.stop / sessions.abort / stopSession / interrupt /
 * terminate / killSession / chat.stop → zero hits outside AbortController /
 * stream / health noise; client.ts defines exactly sessions.list,
 * agents.list, chat.history, sessions.send, sessions.create). So the kill
 * field (killed_at — every fence refuses further work) PLUS this live notice
 * (tells the running agent to STOP now) ARE the stop mechanism. `aborted` is
 * always reported false, `abort_supported` always false — honestly.
 *
 * SECURITY: the session key is an internal routing handle. It is returned in
 * the owner-facing HTTP response (the operator's own board needs the
 * presence signal) but is NEVER written into events/task_activities rows —
 * only a presence boolean goes there.
 */

import { queryOne, run } from '@/lib/db';
import { ACTIVE_EXECUTION_STATES_SQL } from '@/lib/execution-schema';
import { v4 as uuidv4 } from 'uuid';

export interface ActiveExecution {
  id: string;
  session_key: string;
  state: string;
}

/**
 * Newest live execution row for a task, or null. Fail-soft: a missing table
 * (pre-migration box) or any read error means "no running agent" — the caller
 * reports the honest fallback, never throws into the HTTP path.
 */
export function findActiveExecutionForTask(taskId: string): ActiveExecution | null {
  try {
    const row = queryOne<ActiveExecution>(
      `SELECT id, session_key, state FROM task_executions
        WHERE task_id = ? AND state IN ${ACTIVE_EXECUTION_STATES_SQL}
        ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    );
    if (!row?.session_key) return null;
    return row;
  } catch {
    return null; // pre-migration table absent or read error — treated as "no live run"
  }
}

/** Kill notice body: says owner CANCELLED, STOP now, killed_at blocks re-dispatch. */
export function buildKillNotice(taskId: string, taskTitle: string): string {
  return (
    `[Command Center] Owner CANCELLED task "${taskTitle}" (${taskId}). ` +
    `STOP work on it now — do not start anything new for this task. ` +
    `killed_at is set, so no re-dispatch of this task can occur.`
  );
}

/** Owner-update body: one-line header, then the owner's EXACT note text (never rewritten). */
export function buildOwnerUpdateMessage(taskId: string, note: string): string {
  return `Owner update for task ${taskId}:\n${note}`;
}

/**
 * Idempotent kill acknowledgement (migration 168 task_kill_acks, UNIQUE on
 * task_id + INSERT OR IGNORE): cancelling twice never double-writes.
 * Fail-soft: pre-migration table absent → skipped, never throws.
 */
export function recordKillAck(
  taskId: string,
  killedAt: string,
  executionFound: boolean,
  noticeDelivered: boolean,
  noticeError: string | null,
): void {
  try {
    run(
      `INSERT OR IGNORE INTO task_kill_acks
         (id, task_id, killed_at, execution_found, notice_delivered, notice_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        taskId,
        killedAt,
        executionFound ? 1 : 0,
        noticeDelivered ? 1 : 0,
        noticeError,
        new Date().toISOString(),
      ],
    );
  } catch {
    // Pre-migration-168 DB (no table) — the ack is audit-only, never load-bearing.
  }
}
