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
 *   5. Alerts the OPERATOR once — SYSTEM audience only (SWEEP-06): routed to the
 *      Rescue Rangers webhook, or the server log when it is unset. It is NEVER
 *      sent to the client's Telegram (MOVE-IN-SILENCE) — a silent-agent failure
 *      is an operator concern. Dedup is implicit: the task is now `blocked` so
 *      this sweep can never re-select it, so the alert fires once.
 *
 * A `blocked` task is a RECOVERABLE, visible state — the operator (or the
 * existing stale-blocked path) can unblock, fix, and re-dispatch. Nothing is
 * lost; the point is that a dead task stops being invisible.
 *
 * Tuning / opt-out:
 *   • STUCK_IN_PROGRESS_MINUTES  — no-progress threshold in minutes (default 45)
 *   • DISABLE_STUCK_IN_PROGRESS_SWEEP=1  — turn the sweep off entirely
 */

import { queryAll, queryOne, run, parseDbTime } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { notifyByAudience } from '@/lib/notify';
import { transition, TransitionError } from '@/lib/task-lifecycle';
import { probeSessionLiveness } from './execution-watcher';
import { recoverFinishedTaskToReview } from './finished-work-recovery';
import { v4 as uuidv4 } from 'uuid';
import type { Task } from '@/lib/types';

export const STUCK_IN_PROGRESS_SWEEP_CRON = '*/5 * * * *';

/** Default no-progress threshold, in minutes. Deliberately GENEROUS: the `events`
 * table has no mid-turn activity type, so the only pre-block liveness signals are
 * (a) this threshold and (b) the direct session probe (B3). Real turns were
 * observed finishing 6h+ after a 45-min false block, so the floor is raised to 180
 * (env STUCK_IN_PROGRESS_MINUTES overrides; the box also sets 240 as a zero-code
 * mitigation). A genuinely silent-dead task is still caught, just later — and the
 * session probe catches confirmed-alive long turns immediately. */
const DEFAULT_STUCK_IN_PROGRESS_MINUTES = 180;

/** Read the threshold at CALL time (not module load) so a runtime env override
 * actually takes effect — the env is read on every sweep tick. */
function stuckThresholdMinutes(): number {
  const parsed = parseFloat(process.env.STUCK_IN_PROGRESS_MINUTES || String(DEFAULT_STUCK_IN_PROGRESS_MINUTES));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STUCK_IN_PROGRESS_MINUTES;
}

/**
 * SWEEP-05: `events` types that are periodic SWEEP / SYSTEM bookkeeping, NOT
 * genuine agent forward-progress. They must not satisfy the liveness guard, or a
 * silently-dead in_progress task whose only recent `events` rows are system
 * writes (persona backfill, dispatch backoff, stale re-ping, etc.) looks alive
 * and is never blocked (the P39 false-negative).
 *
 * NOTE (verified against this repo): the CC `events` table has NO mid-turn
 * agent-activity type — a dispatched OpenClaw agent streams to its own session,
 * and the web-agent runner publishes to an in-memory bus, not here. The spec's
 * inferred allow-list ('task_progress','agent_message','tool_result') matches
 * ZERO events rows (agent_message is an activity_type on another table;
 * tool_result is an in-memory Anthropic block), so an allow-list would make
 * last_event_at always NULL and over-block every long-running turn. A deny-list
 * of known system noise implements the intent ("exclude sweep/system noise")
 * without that regression: anything not listed still counts as possible liveness.
 */
const LIVENESS_NOISE_EVENT_TYPES = [
  'persona_backfill_attempt',
  'persona_fallback',
  'persona_governance',
  'persona_rescored_at_dispatch',
  'routed_but_not_dispatched',
  'task_dispatch_deferred',
  // The stale sweep's blocked re-ping. BOTH names are listed: 'stale_repinged' is
  // the legacy type (historical rows still carry it) and 'stale_blocked_repinged'
  // is what the sweep writes now that the re-ping is deduped (SWEEP-DEDUP). Listing
  // only one of them would let a re-ping event count as agent LIVENESS and hide a
  // silently-dead task all over again — the P39 false-negative this list prevents.
  'stale_repinged',
  'stale_blocked_repinged',
  'af_model_sovereignty_block',
  'sop_library_gap',
];

interface StuckRow {
  id: string;
  title: string;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  assigned_agent_role: string | null;
  workspace_id: string | null;
  openclaw_session_id: string | null;
  last_progress_at: string | null;
  updated_at: string;
  last_event_at: string | null;
}

export interface StuckSweepResult {
  scanned: number;
  blocked: number;
  blockedIds: string[];
  /** Tasks recovered to `review` because finished work was found (SWEEP-RECOVER). */
  recovered: number;
  recoveredIds: string[];
}

/**
 * SWEEP-RECOVER — the "don't block finished work" gate lives in the shared
 * finished-work-recovery module (used by BOTH this sweep and the stale-task
 * sweep so neither can discard finished work). Before blocking a silently-
 * stalled `in_progress` task, recoverFinishedTaskToReview() checks for a
 * registered deliverable OR on-disk output (the carded-but-trapped 401 defect)
 * and, on either signal, recovers the card to `review` instead of blocking it.
 */

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
  //    SWEEP-06: SYSTEM audience — goes to the operator (Rescue Rangers) or the
  //    server log, NEVER the client Telegram. The previous notifyOwner fallback
  //    pushed a silent-failure diagnostic to the client's Telegram, a
  //    MOVE-IN-SILENCE breach; notifyByAudience('SYSTEM') closes it.
  const message =
    `[silent-failure] Task "${task.title}" (id ${task.id}) auto-blocked by stuck-in-progress ` +
    `sweep — ${reason}`;
  try {
    await notifyByAudience({ audience: 'SYSTEM', message });
  } catch { /* operator alert best-effort */ }

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
    return { scanned: 0, blocked: 0, blockedIds: [], recovered: 0, recoveredIds: [] };
  }

  const cutoffMs = Date.now() - stuckThresholdMinutes() * 60_000;

  // SWEEP-05: the liveness subquery ignores SWEEP/SYSTEM-noise event types so
  // periodic system writes cannot mask a silently-dead task.
  const noisePlaceholders = LIVENESS_NOISE_EVENT_TYPES.map(() => '?').join(', ');
  const rows = queryAll<StuckRow>(
    `SELECT t.id, t.title, t.assigned_agent_id,
            a.name AS assigned_agent_name,
            a.role AS assigned_agent_role,
            t.workspace_id,
            (SELECT s.openclaw_session_id FROM openclaw_sessions s
               WHERE s.agent_id = t.assigned_agent_id AND s.status = 'active'
               ORDER BY s.updated_at DESC LIMIT 1) AS openclaw_session_id,
            t.last_progress_at, t.updated_at,
            (SELECT MAX(e.created_at) FROM events e
               WHERE e.task_id = t.id
                 AND e.type NOT IN (${noisePlaceholders})) AS last_event_at
       FROM tasks t
       LEFT JOIN agents a ON a.id = t.assigned_agent_id
      WHERE t.status = 'in_progress'
        AND t.archived_at IS NULL`,
    [...LIVENESS_NOISE_EVENT_TYPES],
  );

  let blocked = 0;
  const blockedIds: string[] = [];
  let recovered = 0;
  const recoveredIds: string[] = [];

  for (const task of rows) {
    // Progress signal: the last real lifecycle transition (last_progress_at),
    // else updated_at. Only bumped by genuine status changes, so it stays
    // frozen at dispatch time for a silently-dead task.
    const progressAt = task.last_progress_at ?? task.updated_at;
    // B2: parseDbTime corrects the space-dialect misparse (a 'YYYY-MM-DD HH:MM:SS'
    // value read as LOCAL time shifts the age by the box's UTC offset — enough to
    // flip a fresh task to "stuck" or vice-versa).
    const progressMs = parseDbTime(progressAt);
    if (Number.isNaN(progressMs) || progressMs > cutoffMs) continue; // still fresh

    // Liveness guard: a genuinely working agent leaves activity in `events`. If
    // there is a recent event for this task, it is not silently dead — skip it.
    if (task.last_event_at) {
      const evMs = parseDbTime(task.last_event_at);
      if (!Number.isNaN(evMs) && evMs > cutoffMs) continue;
    }

    const ageMinutes = (Date.now() - progressMs) / 60_000;

    // SWEEP-RECOVER: never block FINISHED work. If the agent completed and only
    // the write-back failed (the carded-but-trapped 401), recover the card to
    // review + redeliver its on-disk output instead of blocking it.
    try {
      if (await recoverFinishedTaskToReview(task, 'stuck-in-progress-sweep')) {
        recovered++;
        recoveredIds.push(task.id);
        continue;
      }
    } catch (err) {
      console.error(`[stuck-in-progress-sweep] recovery check failed for ${task.id}:`, (err as Error).message);
    }

    // B3: session-liveness probe. The events table has no mid-turn activity type,
    // so a legitimately long-running turn leaves no `events` row and would be
    // falsely blocked here. Probe the agent's OpenClaw session directly — a
    // message newer than the cutoff proves the turn is ALIVE, so skip it. Only a
    // confirmed-alive signal skips; an unreachable gateway / no timestamp falls
    // through to the block path, preserving the silent-death safety net.
    try {
      const liveness = await probeSessionLiveness(task, cutoffMs);
      if (liveness === 'alive') {
        console.log(
          `[stuck-in-progress-sweep] task ${task.id} skipped — OpenClaw session shows activity newer than the cutoff (alive)`,
        );
        continue;
      }
    } catch (err) {
      console.warn(`[stuck-in-progress-sweep] liveness probe failed for ${task.id} (non-fatal):`, (err as Error).message);
    }

    try {
      await blockStuckTask(task, ageMinutes);
      blocked++;
      blockedIds.push(task.id);
    } catch (err) {
      console.error(`[stuck-in-progress-sweep] failed to block ${task.id}:`, (err as Error).message);
    }
  }

  return { scanned: rows.length, blocked, blockedIds, recovered, recoveredIds };
}
