/**
 * Stale Task Sweep (N36 / SOP-01-Blocked-vs-Return).
 *
 * Detects tasks that have made no progress past their column threshold and
 * returns them to the orchestrator for re-routing. Nothing rots silently.
 *
 * Per-column thresholds (configurable via env, defaults in STALE_THRESHOLDS):
 *   in_progress:   24h
 *   review:        12h
 *   to-do/backlog: 48h
 *   blocked:       72h (re-ping first; +72h to return to orchestrator)
 *
 * What happens:
 *   - Non-Blocked stale tasks: synthesize a broken-but-agent-could handback
 *     and call the return-to-orchestrator logic directly (sets status=backlog,
 *     writes task_returned event, broadcasts task_updated).
 *   - Blocked stale tasks: re-ping the named blocked_on_human once (Telegram
 *     for owner / Rescue Rangers webhook for operator). After a second
 *     threshold (STALE_BLOCKED_REPINGED_THRESHOLD_HOURS), return to the
 *     orchestrator to re-classify.
 *
 * Reads last_progress_at (migration 071). Falls back to updated_at when
 * last_progress_at is NULL (pre-migration-071 DB).
 *
 * Disable with DISABLE_STALE_TASK_SWEEP=1.
 */

import { queryAll, queryOne, run, sqlTime, parseDbTime } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { missionControlAuthHeaders } from '@/lib/mc-auth';
import { notifySystem } from '@/lib/notify';
import { recoverFinishedTaskToReview } from './finished-work-recovery';
import { v4 as uuidv4 } from 'uuid';

export const STALE_TASK_SWEEP_CRON = '*/10 * * * *';

// Per-column stale thresholds in hours.
const STALE_THRESHOLDS: Record<string, number> = {
  in_progress: parseFloat(process.env.STALE_IN_PROGRESS_HOURS || '24'),
  review: parseFloat(process.env.STALE_REVIEW_HOURS || '12'),
  backlog: parseFloat(process.env.STALE_BACKLOG_HOURS || '48'),
  todo: parseFloat(process.env.STALE_TODO_HOURS || '48'),
  // Blocked: first threshold = re-ping; second threshold = return to orchestrator.
  blocked_repinged: parseFloat(process.env.STALE_BLOCKED_REPINGED_HOURS || '144'), // 72+72
};

interface StaleTaskRow {
  id: string;
  title: string;
  status: string;
  description: string | null;
  department: string | null;
  workspace_id: string | null;
  assigned_agent_id: string | null;
  blocked_reason: string | null;
  blocked_on_human: string | null;
  ask: string | null;
  last_progress_at: string | null;
  updated_at: string;
  qc_reroute_attempts: number | null;
}

export interface StaleSweepResult {
  scanned: number;
  returned: number;
  repinged: number;
  /** in_progress tasks recovered to `review` (finished work found on disk /
   *  registered) instead of being bounced to backlog (SWEEP-RECOVER). */
  recovered?: number;
  recoveredIds?: string[];
  skippedReason?: string;
}

function hoursAgo(hours: number): string {
  const d = new Date(Date.now() - hours * 60 * 60 * 1000);
  return d.toISOString();
}

function progressTimestamp(row: StaleTaskRow): string {
  return row.last_progress_at ?? row.updated_at;
}

/**
 * B6: is this review task DELIBERATELY parked by QC (a heuristic no-key /
 * provider-down score), rather than idle-stale? Such a task carries a
 * `[QC-HEURISTIC…]` or `[QC-DEFERRED-PROVIDER-DOWN]` qc_review event and is held
 * in review ON PURPOSE (awaiting a human promote or provider recovery). Bouncing
 * it back to the orchestrator just churns the review lane (the 1,958 task_returned
 * / 5,616 stale_repinged furnace), so the stale sweep must leave it alone.
 * NOTE: SQLite LIKE treats '[' literally (no bracket char-classes), so the
 * '%[QC-HEURISTIC%' pattern matches both [QC-HEURISTIC] and [QC-HEURISTIC-FINAL].
 */
function isParkedInReview(taskId: string): boolean {
  try {
    const row = queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND type = 'qc_review'
          AND (message LIKE '%[QC-HEURISTIC%' OR message LIKE '%[QC-DEFERRED-PROVIDER-DOWN]%')`,
      [taskId],
    );
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Attempt to notify the blocked_on_human via the available channels.
 * Best-effort: failure here must never crash the sweep.
 */
async function repingBlockedHuman(task: StaleTaskRow): Promise<void> {
  const who = task.blocked_on_human ?? 'owner';
  const message =
    `[STALE-BLOCKED] Task "${task.title}" (id: ${task.id}) has been waiting in Blocked for over ` +
    `${STALE_THRESHOLDS['blocked_repinged'] / 2}h without a response. ` +
    `Reminder: ${task.ask ?? '(no ask specified)'}`;

  if (who === 'operator') {
    // SWEEP-06 / MSG-06: an operator re-ping is a SYSTEM concern — route it
    // through the single notifySystem() path (Rescue Rangers webhook, or a
    // server log when unset). It must NEVER reach a client Telegram.
    notifySystem(message, { agent: 'stale-task-sweep', action: 'escalate' });
  } else {
    // Owner: notify via the Command Center's internal message route (which
    // triggers Telegram if wired). Best-effort -- no throw on failure.
    const ccUrl = getMissionControlUrl();
    try {
      // AUTH (SWEEP-401): this is a SERVER-SIDE loopback to our own /api/events —
      // it carries NO same-origin Origin/Referer, so middleware Gate B treats it
      // as EXTERNAL and (with MC_API_TOKEN set) hard-401s a POST without a bearer.
      // Before this fix every owner re-ping 401'd and was swallowed by the catch
      // below (one box logged ~1,301 rejections at ~600/hr), silently dropping
      // stale-blocked owner notifications fleet-wide. Present the canonical bearer.
      const resp = await fetch(`${ccUrl}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...missionControlAuthHeaders() },
        body: JSON.stringify({
          type: 'stale_blocked_repinged',
          payload: { task_id: task.id, message },
        }),
      });
      if (!resp.ok) {
        // Do not swallow silently — a rejected re-ping means the owner was NOT
        // notified; surface it loudly (this is exactly the failure that stayed
        // invisible for a month behind a bare console.warn on the catch alone).
        console.error(
          `[stale-task-sweep] Owner re-ping POST /api/events returned ${resp.status} — owner was NOT notified` +
            (resp.status === 401 || resp.status === 403
              ? ' (AUTH: verify MC_API_TOKEN is set in this process and matches the Command Center)'
              : ''),
        );
      }
    } catch (err) {
      console.warn('[stale-task-sweep] Owner re-ping notification failed:', (err as Error).message);
    }
  }
}

/**
 * Return a stale non-Blocked task to the orchestrator.
 * Mirrors the POST /api/tasks/[id]/return-to-orchestrator logic inline
 * so the sweep does not depend on an HTTP round-trip to itself.
 */
function returnToOrchestrator(task: StaleTaskRow, reason: string): void {
  const now = new Date().toISOString();
  const currentAttempts = task.qc_reroute_attempts ?? 0;
  const newAttempts = currentAttempts + 1;

  const handbackNote = [
    `[STALE-RETURN #${newAttempts}] ${now}`,
    `Problem: ${reason}`,
    `Tried: stale sweep detected no progress`,
    `Needs: orchestrator re-route or human triage`,
  ].join('\n');

  const updatedDescription = task.description
    ? `${handbackNote}\n\n---\n\n${task.description}`
    : handbackNote;

  // SWEEP-03 (drag-back trap): a task returning to backlog FROM blocked would
  // otherwise keep dispatch_attempts >= cap and a stale backoff window, so every
  // advancer (intake-advance / backlog-redispatch) would filter it out and it
  // would rot in backlog forever. Reset the dispatch accounting ONLY on the
  // from-blocked transition — a non-blocked stale return (in_progress/review →
  // backlog) is left untouched so a genuinely looping task still stays capped.
  const fromBlocked = task.status === 'blocked';
  const dispatchResetClause = fromBlocked
    ? `,
        dispatch_attempts = 0,
        next_dispatch_eligible_at = NULL`
    : '';

  try {
    run(
      `UPDATE tasks SET
        status = 'backlog',
        description = ?,
        qc_reroute_attempts = ?,
        last_progress_at = ?,
        updated_at = ?${dispatchResetClause}
       WHERE id = ?`,
      [updatedDescription, newAttempts, now, now, task.id],
    );

    run(
      `INSERT INTO events (id, type, task_id, message, created_at)
       VALUES (?, 'task_returned', ?, ?, ?)`,
      [uuidv4(), task.id, `[STALE-RETURN] ${reason}`, now],
    );

    broadcast({ type: 'task_updated', payload: { id: task.id, status: 'backlog' } });
  } catch (err) {
    console.warn(`[stale-task-sweep] returnToOrchestrator failed for ${task.id}:`, (err as Error).message);
  }
}

export async function runStaleTaskSweep(): Promise<StaleSweepResult> {
  if (
    process.env.DISABLE_STALE_TASK_SWEEP === '1' ||
    process.env.DISABLE_STALE_TASK_SWEEP === 'true'
  ) {
    return { scanned: 0, returned: 0, repinged: 0, skippedReason: 'DISABLE_STALE_TASK_SWEEP set' };
  }

  // Guard: last_progress_at column must exist (migration 071).
  let hasLastProgressAt = false;
  try {
    const cols = queryAll<{ name: string }>('PRAGMA table_info(tasks)', []);
    hasLastProgressAt = cols.some((c) => c.name === 'last_progress_at');
  } catch {
    return { scanned: 0, returned: 0, repinged: 0, skippedReason: 'Cannot read tasks schema' };
  }

  if (!hasLastProgressAt) {
    return { scanned: 0, returned: 0, repinged: 0, skippedReason: 'Migration 071 not applied yet (no last_progress_at column)' };
  }

  const progressCol = 'COALESCE(last_progress_at, updated_at)';

  // Select all non-done, non-archived tasks whose progress timestamp is old enough
  // for ANY column threshold. We filter in-process below.
  const oldestThreshold = Math.max(
    STALE_THRESHOLDS.in_progress,
    STALE_THRESHOLDS.review,
    STALE_THRESHOLDS.backlog,
    STALE_THRESHOLDS.todo,
    STALE_THRESHOLDS.blocked_repinged,
  );

  let candidates: StaleTaskRow[];
  try {
    candidates = queryAll<StaleTaskRow>(
      `SELECT id, title, status, description, department, workspace_id,
              assigned_agent_id, blocked_reason, blocked_on_human, ask,
              last_progress_at, updated_at, qc_reroute_attempts
       FROM tasks
       WHERE archived_at IS NULL
         AND status NOT IN ('done')
         AND ${sqlTime(progressCol)} < ${sqlTime('?')}
       ORDER BY ${sqlTime(progressCol)} ASC
       LIMIT 100`,
      [hoursAgo(Math.min(STALE_THRESHOLDS.review, oldestThreshold))],
    );
  } catch (err) {
    return { scanned: 0, returned: 0, repinged: 0, skippedReason: `Query failed: ${(err as Error).message}` };
  }

  let returned = 0;
  let repinged = 0;
  let recovered = 0;
  const recoveredIds: string[] = [];

  for (const task of candidates) {
    try {
      const progressTs = progressTimestamp(task);
      // B2: parseDbTime corrects the space-dialect misparse — new Date('YYYY-MM-DD
      // HH:MM:SS') reads as LOCAL time and shifts the age by the box's UTC offset.
      const progressDate = parseDbTime(progressTs);
      if (Number.isNaN(progressDate)) continue;
      const ageHours = (Date.now() - progressDate) / (1000 * 60 * 60);

      if (task.status === 'blocked') {
        // Blocked tasks: re-ping first threshold, return after second.
        const repingThreshold = STALE_THRESHOLDS.blocked_repinged / 2; // default 72h
        const returnThreshold = STALE_THRESHOLDS.blocked_repinged; // default 144h total

        if (ageHours >= returnThreshold) {
          // Second threshold passed: return to orchestrator.
          returnToOrchestrator(task, `Blocked task stale for ${Math.round(ageHours)}h with no human response to: "${task.ask ?? '(no ask)'}"`);
          returned++;
        } else if (ageHours >= repingThreshold) {
          // First threshold: re-ping the named human.
          await repingBlockedHuman(task);
          // Write stale_returned event for audit trail.
          const now = new Date().toISOString();
          try {
            run(
              `INSERT INTO events (id, type, task_id, message, created_at)
               VALUES (?, 'stale_repinged', ?, ?, ?)`,
              [uuidv4(), task.id, `Re-pinged ${task.blocked_on_human ?? 'owner'} on blocked task (stale ${Math.round(ageHours)}h)`, now],
            );
          } catch {
            // events table issue -- non-fatal
          }
          repinged++;
        }
        continue;
      }

      // Non-Blocked tasks: check per-column threshold.
      const thresholdHours =
        task.status === 'in_progress' ? STALE_THRESHOLDS.in_progress :
        task.status === 'review' ? STALE_THRESHOLDS.review :
        STALE_THRESHOLDS.backlog;

      if (ageHours >= thresholdHours) {
        // B6: a review task deliberately parked by QC (heuristic no-key /
        // provider-down) is NOT idle-stale — leave it for the QC sweep or an
        // operator promote instead of churning it back to the orchestrator.
        if (task.status === 'review' && isParkedInReview(task.id)) {
          continue;
        }
        // SWEEP-RECOVER: never bounce FINISHED in_progress work back to backlog.
        // If the agent completed and only the write-back failed (the carded-but-
        // trapped MC_API_TOKEN 401), recover the card to `review` (redelivering
        // on-disk output) instead of demoting it. Only in_progress can carry
        // finished-but-unregistered work; review/backlog fall through unchanged.
        if (task.status === 'in_progress') {
          try {
            if (await recoverFinishedTaskToReview(task, 'stale-task-sweep')) {
              recovered++;
              recoveredIds.push(task.id);
              continue;
            }
          } catch (err) {
            console.error(`[stale-task-sweep] recovery check failed for ${task.id}:`, (err as Error).message);
          }
        }
        returnToOrchestrator(
          task,
          `Task stale in '${task.status}' for ${Math.round(ageHours)}h (threshold: ${thresholdHours}h) with no progress`,
        );
        returned++;
      }
    } catch (err) {
      console.warn(`[stale-task-sweep] Processing task ${task.id} failed:`, (err as Error).message);
    }
  }

  return { scanned: candidates.length, returned, repinged, recovered, recoveredIds };
}
