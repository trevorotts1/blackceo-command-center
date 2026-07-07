/**
 * Stuck-in-progress sweep — silent-failure safety net.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * A task that is SUCCESSFULLY dispatched moves to `in_progress` and its agent
 * to `working`. If the agent's turn then dies mid-work (repeated tool failures,
 * a degenerate loop, a thinking-only turn that simply ends) WITHOUT emitting a
 * `TASK_COMPLETE:` marker or writing any terminal status, the task rots
 * invisibly:
 *
 *   • `execution-watcher` (execution-reconcile, every 2 min) only advances
 *     tasks that report SUCCESS (`TASK_COMPLETE:`). A failed/aborted turn
 *     produces no marker, so it is never touched.
 *   • `stale-task-sweep` (every 10 min) does touch `in_progress`, but its
 *     threshold is 24h and its remedy is a silent bounce back to `backlog`
 *     (a re-route) — no `blocked`, no error surfaced, no operator alert. For a
 *     deterministic failure (e.g. a bad send target) that just re-loops a day
 *     later.
 *   • `backlog-redispatch-sweep` has a retry→block→escalate path, but it only
 *     selects `status='backlog'` and is disabled on some boxes.
 *   • `recordDispatchFailure` blocks + notifies, but only on the PRE-agent
 *     dispatch path (gateway down / no model) — never after `in_progress`.
 *
 * Net: nothing marks a silently-failed `in_progress` task `blocked` or alerts
 * the operator within a useful window. This sweep is that missing supervisor.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 * For every `in_progress` task whose last progress signal is older than
 * `STUCK_IN_PROGRESS_MINUTES` (default 45) AND which has emitted no recent
 * `events` row (liveness guard — a genuinely working agent leaves activity):
 *   1. Transitions the task to `blocked` via the audited `transition()` — which
 *      writes the structured `task_events` row that a raw UPDATE skips (the very
 *      audit gap that hid the original incident, where only the initial
 *      backlog→in_progress event ever existed).
 *   2. Records the failure context in the block metadata columns
 *      (`block_reason`, `block_needs`, `block_audience='SYSTEM'`,
 *      `blocked_on_human='operator'`) — mirrors `recordDispatchFailure`.
 *   3. Frees the wedged agent (`working` → `standby`).
 *   4. Broadcasts `task_updated` so the board moves the card immediately.
 *   5. Alerts the operator once — via the Rescue Rangers webhook (per AGENTS.md),
 *      falling back to `notifyOwner`. Dedup is implicit: the task is now
 *      `blocked` so this sweep can never re-select it, so the alert fires once.
 *
 * A `blocked` task is a RECOVERABLE, visible state — the operator (or the
 * existing stale-blocked path) can unblock, fix, and re-dispatch. Nothing is
 * lost; the point is that a dead task stops being invisible.
 *
 * Tuning / opt-out:
 *   • STUCK_IN_PROGRESS_MINUTES  — no-progress threshold in minutes (default 45)
 *   • DISABLE_STUCK_IN_PROGRESS_SWEEP=1  — turn the sweep off entirely
 */

import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { notifyOwner } from '@/lib/notify';
import { transition, TransitionError } from '@/lib/task-lifecycle';
import { v4 as uuidv4 } from 'uuid';
import type { Task } from '@/lib/types';

export const STUCK_IN_PROGRESS_SWEEP_CRON = '*/5 * * * *';

/** No-progress threshold, in minutes. Generous by default to avoid blocking a
 * legitimately long-running turn; a silent-dead task is caught within the hour. */
const STUCK_IN_PROGRESS_MINUTES = parseFloat(process.env.STUCK_IN_PROGRESS_MINUTES || '45');

interface StuckRow {
  id: string;
  title: string;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  last_progress_at: string | null;
  updated_at: string;
  last_event_at: string | null;
}

export interface StuckSweepResult {
  scanned: number;
  blocked: number;
  blockedIds: string[];
}

/** Block one stuck task, free its agent, and alert the operator once. */
async function blockStuckTask(task: StuckRow, ageMinutes: number): Promise<void> {
  const now = new Date().toISOString();
  const agentLabel = task.assigned_agent_name ?? task.assigned_agent_id ?? 'unknown agent';
  const reason =
    `No progress for ${Math.round(ageMinutes)} min while in_progress — the assigned agent's ` +
    `turn ended without reporting completion or failure (possible silent agent failure).`;
  const needs =
    `Operator review: agent "${agentLabel}" stalled on task "${task.title}". ` +
    `Check the department session log, resolve the blocker, then re-dispatch or close.`;

  // 1. Audited status change. transition() writes the structured task_events
  //    row (the audit that was missing from the original incident). Fall back to
  //    a raw block write (mirrors recordDispatchFailure) if the transition is
  //    ever rejected, so an edge case never leaves the task silently stuck.
  try {
    await transition(task.id, 'blocked', { actor: 'stuck-in-progress-sweep', reason });
  } catch (err) {
    if (err instanceof TransitionError) {
      run(
        `UPDATE tasks SET status='blocked', updated_at=? WHERE id=? AND status='in_progress'`,
        [now, task.id],
      );
      try {
        run(
          `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [uuidv4(), 'task_blocked', task.assigned_agent_id, task.id, `[stuck-in-progress-sweep] ${reason}`, now],
        );
      } catch { /* legacy events table unavailable — non-fatal */ }
    } else {
      throw err;
    }
  }

  // 2. Block metadata (transition() sets only status/updated_at/events).
  run(
    `UPDATE tasks
        SET block_reason = ?, block_needs = ?, block_audience = 'SYSTEM',
            blocked_on_human = 'operator', last_progress_at = ?
      WHERE id = ?`,
    [reason, needs, now, task.id],
  );

  // 3. Free the wedged agent.
  if (task.assigned_agent_id) {
    run(
      `UPDATE agents SET status='standby', updated_at=? WHERE id=? AND status='working'`,
      [now, task.assigned_agent_id],
    );
  }

  // 4. Move the card on the board immediately.
  try {
    const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
    if (updated) broadcast({ type: 'task_updated', payload: updated });
  } catch { /* broadcast best-effort */ }

  // 5. Operator alert (fires exactly once: the task is 'blocked' now).
  const message =
    `🚫 [silent-failure] Task "${task.title}" (id ${task.id}) auto-blocked by stuck-in-progress ` +
    `sweep — ${reason}`;
  const webhookUrl = process.env.RESCUE_RANGERS_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'escalate', agent: 'stuck-in-progress-sweep', message }),
      });
    } catch (err) {
      console.warn('[stuck-in-progress-sweep] Rescue Rangers alert failed:', (err as Error).message);
    }
  } else {
    try {
      notifyOwner(message);
    } catch { /* owner notify best-effort */ }
  }

  console.warn(
    `[stuck-in-progress-sweep] task ${task.id} BLOCKED (${Math.round(ageMinutes)}min no progress, agent ${agentLabel})`,
  );
}

/**
 * Scan `in_progress` tasks and block any that have gone silent past the
 * threshold. Best-effort and never-throw: a failure on one task must not stop
 * the sweep or crash the scheduler.
 */
export async function runStuckInProgressSweep(): Promise<StuckSweepResult> {
  if (
    process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP === '1' ||
    process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP === 'true'
  ) {
    return { scanned: 0, blocked: 0, blockedIds: [] };
  }

  const cutoffMs = Date.now() - STUCK_IN_PROGRESS_MINUTES * 60_000;

  const rows = queryAll<StuckRow>(
    `SELECT t.id, t.title, t.assigned_agent_id,
            a.name AS assigned_agent_name,
            t.last_progress_at, t.updated_at,
            (SELECT MAX(e.created_at) FROM events e WHERE e.task_id = t.id) AS last_event_at
       FROM tasks t
       LEFT JOIN agents a ON a.id = t.assigned_agent_id
      WHERE t.status = 'in_progress'
        AND t.archived_at IS NULL`,
  );

  let blocked = 0;
  const blockedIds: string[] = [];

  for (const task of rows) {
    // Progress signal: the last real lifecycle transition (last_progress_at),
    // else updated_at. Only bumped by genuine status changes, so it stays
    // frozen at dispatch time for a silently-dead task.
    const progressAt = task.last_progress_at ?? task.updated_at;
    const progressMs = Date.parse(progressAt);
    if (Number.isNaN(progressMs) || progressMs > cutoffMs) continue; // still fresh

    // Liveness guard: a genuinely working agent leaves activity in `events`. If
    // there is a recent event for this task, it is not silently dead — skip it.
    if (task.last_event_at) {
      const evMs = Date.parse(task.last_event_at);
      if (!Number.isNaN(evMs) && evMs > cutoffMs) continue;
    }

    const ageMinutes = (Date.now() - progressMs) / 60_000;
    try {
      await blockStuckTask(task, ageMinutes);
      blocked++;
      blockedIds.push(task.id);
    } catch (err) {
      console.error(`[stuck-in-progress-sweep] failed to block ${task.id}:`, (err as Error).message);
    }
  }

  return { scanned: rows.length, blocked, blockedIds };
}
