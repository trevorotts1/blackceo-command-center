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
 * PAUSED BY DEFAULT (SWEEP-01): intake-advance-sweep is the single live
 * board-advancement authority. This legacy sweep is a dormant rollback net and
 * runs ONLY when explicitly opted in per box with
 * BACKLOG_REDISPATCH_SWEEP_ENABLED=1 (or =true). Its JOBS entry stays registered
 * so re-enabling needs no code change — it just returns immediately while off.
 */

import { queryAll, queryOne, run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '@/lib/events';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import { QC_MAX_REROUTES } from '@/lib/qc-scorer';
import type { Task } from '@/lib/types';

export interface BacklogRedispatchResult {
  scanned: number;
  dispatched: number;
  /** Tasks escalated to `blocked` this tick because they hit the re-dispatch cap. */
  escalated?: number;
  skippedReason?: string;
}

interface BacklogTaskRow {
  id: string;
  title: string;
  qc_reroute_attempts: number | null;
  redispatch_count: number | null;
  updated_at: string;
}

// ── RE-DISPATCH ESCALATION CAP (Point 6 fix 2) ──────────────────────────────
// The cheap re-dispatch loop retries a stuck-but-assigned backlog task every
// tick. Paths that go through recordDispatchFailure (gateway down, no sovereign
// model) already block at MAX_DISPATCH_ATTEMPTS. But paths that DON'T — a SOP-
// authoring hold that never completes, a config problem that never clears — leave
// the task in backlog with dispatch_attempts untouched, so it is re-fired forever
// (no furnace: the guards return before any LLM call, but also no escalation).
//
// Mirroring the QC_MAX_REROUTES cap: after REDISPATCH_MAX_ATTEMPTS (K) cheap
// retries AND the task has been stuck for at least REDISPATCH_ESCALATE_HOURS (M),
// escalate it to `blocked` with a [REDISPATCH-CAP] note on the operator feed
// (SYSTEM audience — a config/hold issue for the operator, never client spam).
// Both defaults are env-overridable (REDISPATCH_MAX_ATTEMPTS / REDISPATCH_ESCALATE_HOURS),
// following the QC_MAX_REROUTES pattern.
export const REDISPATCH_MAX_ATTEMPTS = 20;
export const REDISPATCH_ESCALATE_HOURS = 6;

/**
 * Escalate a task that has exhausted the cheap re-dispatch loop to `blocked`,
 * with a [REDISPATCH-CAP] operator-feed note. Concurrency-safe (WHERE status =
 * 'backlog'), SYSTEM audience (no client Telegram), best-effort broadcast.
 */
function escalateStuckBacklogTask(
  row: BacklogTaskRow,
  priorCount: number,
  cap: number,
  hours: number,
): void {
  const now = new Date().toISOString();
  const blockedNote =
    `[REDISPATCH-CAP] Re-dispatched ${priorCount} time(s) (cap ${cap}) over ≥${hours}h without advancing — ` +
    `escalating to blocked for operator action. Likely a config problem or an unresolved hold the executor ` +
    `cannot clear by retrying.`;

  run(
    `UPDATE tasks
        SET status = 'blocked',
            block_reason = ?,
            block_needs = ?,
            block_audience = 'SYSTEM',
            next_dispatch_eligible_at = NULL,
            updated_at = ?
      WHERE id = ? AND status = 'backlog'`,
    [
      `Re-dispatch cap: ${priorCount} cheap retries over ≥${hours}h, still stuck in backlog`,
      `Operator action required: diagnose why "${row.title}" cannot advance (gateway / runtime / config / SOP hold) ` +
        `and re-route or fix. It will not auto-retry further.`,
      now,
      row.id,
    ],
  );

  // Operator-feed events (SYSTEM audience → no client Telegram, per silent-updates doctrine).
  run(
    `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'task_blocked', ?, ?, ?)`,
    [uuidv4(), row.id, blockedNote, now],
  );
  run(
    `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'task_status_changed', ?, ?, ?)`,
    [
      uuidv4(),
      row.id,
      `[REDISPATCH-CAP] "${row.title}" blocked after ${priorCount} re-dispatch attempt(s) — operator diagnosis needed (audience: SYSTEM).`,
      now,
    ],
  );

  try {
    const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [row.id]);
    if (updated) broadcast({ type: 'task_updated', payload: updated });
  } catch {
    /* broadcast best-effort */
  }

  console.warn(
    `[backlog-redispatch] task ${row.id} ESCALATED to blocked ([REDISPATCH-CAP], ${priorCount} attempts over ≥${hours}h)`,
  );
}

export async function runBacklogRedispatchSweep(): Promise<BacklogRedispatchResult> {
  // SWEEP-01: PAUSED BY DEFAULT. intake-advance-sweep is the single live
  // advancer; this legacy sweep is opt-in (BACKLOG_REDISPATCH_SWEEP_ENABLED=1)
  // so a fresh in-repo box never double-advances. Previously this only skipped
  // on an explicit =0, so the CHANGELOG's "REMAINS paused via *_ENABLED=0" claim
  // was false in the repo and both legacy advancers ran at default.
  if (
    process.env.BACKLOG_REDISPATCH_SWEEP_ENABLED !== '1' &&
    process.env.BACKLOG_REDISPATCH_SWEEP_ENABLED !== 'true'
  ) {
    return {
      scanned: 0,
      dispatched: 0,
      skippedReason: 'backlog-redispatch paused (opt in with BACKLOG_REDISPATCH_SWEEP_ENABLED=1)',
    };
  }

  const cap = parseInt(process.env.QC_MAX_REROUTES || String(QC_MAX_REROUTES), 10);
  const dispatchCap = Math.max(1, parseInt(process.env.MAX_DISPATCH_ATTEMPTS || '5', 10));
  const batch = parseInt(process.env.BACKLOG_REDISPATCH_BATCH || '25', 10);
  const graceSeconds = parseInt(process.env.BACKLOG_REDISPATCH_GRACE_SECONDS || '120', 10);
  const now = new Date().toISOString();
  const graceCutoff = new Date(Date.now() - graceSeconds * 1000).toISOString();

  // Assigned, still-backlog, not-archived, under the re-route cap, not on a
  // master/CEO agent, and last touched before the grace window. Oldest first so
  // the most-stuck cards drain first.
  //
  // W8.2 anti-furnace: ALSO require the task to be under the dispatch-attempt cap
  // and past its exponential-backoff window. Without these, a task that can't
  // advance (gateway down / no sovereign model / no per-dept runtime) was
  // re-fired every 2 min forever — the exact furnace this guard kills. A blocked
  // or backed-off task now drops out of selection instead of re-looping.
  const rows = queryAll<BacklogTaskRow>(
    `SELECT t.id AS id,
            t.title AS title,
            t.qc_reroute_attempts AS qc_reroute_attempts,
            t.redispatch_count AS redispatch_count,
            t.updated_at AS updated_at
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
      WHERE t.status = 'backlog'
        AND t.assigned_agent_id IS NOT NULL
        AND t.archived_at IS NULL
        AND (t.qc_reroute_attempts IS NULL OR t.qc_reroute_attempts < ?)
        AND (t.dispatch_attempts IS NULL OR t.dispatch_attempts < ?)
        AND (t.next_dispatch_eligible_at IS NULL OR t.next_dispatch_eligible_at <= ?)
        AND (a.is_master IS NULL OR a.is_master = 0)
        AND t.updated_at <= ?
      ORDER BY t.updated_at ASC
      LIMIT ?`,
    [cap, dispatchCap, now, graceCutoff, batch],
  );

  if (rows.length === 0) {
    return { scanned: 0, dispatched: 0, escalated: 0 };
  }

  // Re-dispatch escalation cap (Point 6 fix 2): env-overridable, QC_MAX_REROUTES-style.
  const escalateCap = Math.max(
    1,
    parseInt(process.env.REDISPATCH_MAX_ATTEMPTS || String(REDISPATCH_MAX_ATTEMPTS), 10) ||
      REDISPATCH_MAX_ATTEMPTS,
  );
  const escalateHours = Math.max(
    1,
    parseInt(process.env.REDISPATCH_ESCALATE_HOURS || String(REDISPATCH_ESCALATE_HOURS), 10) ||
      REDISPATCH_ESCALATE_HOURS,
  );
  const stuckCutoff = new Date(Date.now() - escalateHours * 3600 * 1000).toISOString();

  let dispatched = 0;
  let escalated = 0;
  for (const row of rows) {
    const priorCount = row.redispatch_count ?? 0;

    // ESCALATION CAP: retried at least K times AND stuck ≥ M hours (updated_at
    // stays frozen while a task idles in backlog on a non-recordDispatchFailure
    // path) → block + operator note instead of re-firing forever.
    if (priorCount >= escalateCap && row.updated_at <= stuckCutoff) {
      try {
        escalateStuckBacklogTask(row, priorCount, escalateCap, escalateHours);
        escalated++;
      } catch (err) {
        console.warn(
          `[backlog-redispatch] escalation failed for task ${row.id}:`,
          (err as Error).message,
        );
      }
      continue;
    }

    // Persist the cheap-retry counter (cap accounting + audit), then re-dispatch.
    try {
      run(`UPDATE tasks SET redispatch_count = ? WHERE id = ?`, [priorCount + 1, row.id]);
    } catch {
      /* pre-migration DB (no redispatch_count) — tolerant, dispatch still proceeds */
    }

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

  return { scanned: rows.length, dispatched, escalated };
}
