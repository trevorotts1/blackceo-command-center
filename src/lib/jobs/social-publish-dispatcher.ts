/**
 * social-publish-dispatcher.ts — the durable consumer for the Skill 35
 * publish queue (F03, social/wf05-durable-exec).
 *
 * PROBLEM: POST /api/skill-35/publish inserts a company-bound publish_queue
 * row and broadcasts `publish_queued:<company_id>` (F01), but nothing in the
 * repository consumed the row — the button acknowledged a request with no
 * repository-backed executor. This module is that executor.
 *
 * CONTRACT (dispatch.json, W0):
 *   operation_key (idempotency), worker_id, attempt, fencing_token
 *   (lease_owner/lease_expires_at), lease_expires_at, heartbeat_at, retry_at,
 *   task_id, execution_id. Rule: a stale worker cannot commit after
 *   reassignment; a side-effect timeout enters reconciliation before retry.
 *
 * HOW IT WORKS (per tick, every 2 minutes via scheduler.ts):
 *   1. CLAIM — atomically move ONE claimable row (queued|retrying, past
 *      retry_at) to 'running' with a compare-and-swap that also stamps the
 *      lease owner + expiry. Only the winner proceeds; concurrent ticks and
 *      multiple boxes each take disjoint rows.
 *   2. INGEST — create the canonical task via createTaskCore (the same path
 *      /api/tasks/ingest uses), company-scoped to the queue row's company_id
 *      with idempotency so a retried dispatch never creates a second card.
 *   3. DISPATCH — autoDispatchTask (canonical task-dispatcher) with the full
 *      guard chain. Its returned executionId is persisted on the queue row
 *      BEFORE the row is acknowledged (status → running stays, linkage kept),
 *      so a crash between dispatch and acknowledgement is reconciled, never
 *      duplicated.
 *   4. ACK — on 'acknowledged', persist task_id + execution_id and hold
 *      status='running' until the agent-completion webhook advances the real
 *      task; the publish row then follows the task's terminal state on later
 *      sweeps (link-follow, below).
 *
 * IDEMPOTENCY: idempotency_key = sha256(company_id + task_id + topic +
 * platforms) computed at claim time; createTaskCore dedupes on it.
 *
 * ATTEMPT LIMITS: SOCIAL_PUBLISH_MAX_ATTEMPTS (default 5) hard-cap; past it
 * the row → 'failed' with the last error (visible, never silently re-looped).
 * Transient dispatch failures get exponential backoff via retry_at.
 *
 * OVERDUE: `deriveQueueItemState` computes an actionable 'overdue' for a
 * queued row older than the consumer cadence × grace (default 10 min), and
 * `runSocialPublishOverdueSweep` requeues flagged rows (attempts remaining)
 * to 'retrying' with retry_at=now so the next tick resumes them — or fails
 * them visibly when the attempt cap is exhausted. No operator reset needed.
 *
 * LINK-FOLLOW: once a row carries cc_task_id, later ticks read the task's
 * status and mirror terminal outcomes: task done → row 'published' (the
 * dashboard's own lifecycle 'done' naming for a publish), task blocked →
 * row 'failed' with the block reason. In-progress/review keeps 'running'
 * with truthful linkage.
 */

import { createHash } from 'crypto';
import { queryAll, queryOne, run, getDb } from '@/lib/db';
import { createTaskCore } from '@/lib/tasks';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import { latestExecution } from '@/lib/execution-attempts';
import { throwIfJobLeaseLost } from '@/lib/jobs/job-lease';
import { broadcast } from '@/lib/events';
import { notifySystem } from '@/lib/notify';

// ── Tunables (env-overridable, furnace-proof floors) ────────────────────────
const MAX_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.SOCIAL_PUBLISH_MAX_ATTEMPTS || '5', 10),
);
const BACKOFF_BASE_SECONDS = Math.max(
  30,
  parseInt(process.env.SOCIAL_PUBLISH_BACKOFF_BASE_SECONDS || '120', 10),
);
const BACKOFF_MAX_SECONDS = Math.max(
  60,
  parseInt(process.env.SOCIAL_PUBLISH_BACKOFF_MAX_SECONDS || '3600', 10),
);
const LEASE_SECONDS = Math.max(
  60,
  parseInt(process.env.SOCIAL_PUBLISH_LEASE_SECONDS || '300', 10),
);
// A queued row older than the cadence × grace is overdue — the consumer ticks
// every 2 min (scheduler), so 10 min of silence means it is stopped.
const OVERDUE_MINUTES = Math.max(
  5,
  parseInt(process.env.SOCIAL_PUBLISH_OVERDUE_MINUTES || '10', 10),
);
const BATCH_LIMIT = Math.max(1, parseInt(process.env.SOCIAL_PUBLISH_BATCH_LIMIT || '3', 10));

/** The W0 contract states the queue row persists. */
export type PublishQueueState =
  | 'queued'
  | 'running'
  | 'retrying'
  | 'scheduled'
  | 'published'
  | 'failed'
  | 'overdue'
  | 'done'
  | 'cancelled';

interface PublishQueueRow {
  id: string;
  task_id: string | null;
  company_id: string;
  sheet_id: string | null;
  topic: string;
  platforms: string; // JSON string
  schedule: string | null;
  status: string;
  run_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  cc_task_id: string | null;
  cc_execution_id: string | null;
  idempotency_key: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt_count: number | null;
  last_attempt_at: string | null;
  retry_at: string | null;
  overdue_since: string | null;
}

/**
 * Read-side state derivation (F03 required outcome: "A stopped consumer
 * generates an actionable overdue alert, not indefinite 'working'").
 * Extends the stored status with derived truth:
 *   - 'running' whose lease expired AND whose task never dispatched →
 *     surfaced as overdue (consumer died mid-dispatch).
 *   - 'queued' older than OVERDUE_MINUTES → overdue (consumer stopped).
 *   - terminal states pass through unchanged.
 */
export function deriveQueueItemState(row: {
  status: string;
  created_at: string;
  lease_expires_at?: string | null;
  cc_task_id?: string | null;
  retry_at?: string | null;
  now?: Date;
}): PublishQueueState {
  const status = (row.status || 'queued').toLowerCase() as PublishQueueState;
  const now = row.now ?? new Date();
  if (status === 'queued') {
    const ageMs = now.getTime() - new Date(row.created_at).getTime();
    if (ageMs > OVERDUE_MINUTES * 60_000) return 'overdue';
    return 'queued';
  }
  if (status === 'running') {
    // Mid-dispatch death: lease lapsed and no canonical task linkage yet.
    const leaseExpired =
      row.lease_expires_at && new Date(row.lease_expires_at).getTime() < now.getTime();
    if (leaseExpired && !row.cc_task_id) return 'overdue';
    return 'running';
  }
  return status;
}

/** Deterministic idempotency key: company+task+topic+platforms hash. */
export function publishIdempotencyKey(input: {
  companyId: string;
  taskId: string | null;
  topic: string;
  platforms: string[];
}): string {
  const canonical = JSON.stringify({
    company_id: input.companyId,
    task_id: input.taskId,
    topic: input.topic.trim().toLowerCase(),
    platforms: [...input.platforms].map((p) => p.trim().toLowerCase()).sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function backoffSeconds(attempt: number): number {
  return Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * Math.pow(2, attempt - 1));
}

function parsePlatforms(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * One consumer tick. Claims up to BATCH_LIMIT claimable rows and drives each
 * through ingest → dispatch → ack. Never throws (scheduler-safe): every
 * per-row failure is caught and recorded on the row.
 */
export async function runSocialPublishDispatcherSweep(): Promise<{
  scanned: number;
  dispatched: number;
  retried: number;
  failed: number;
  followed: number;
  skippedReason?: string;
}> {
  const db = getDb();
  const nowIso = new Date().toISOString();

  // ── LINK-FOLLOW first: rows already dispatched follow their canonical task ──
  const runningRows = queryAll<PublishQueueRow>(
    `SELECT * FROM publish_queue
      WHERE status = 'running' AND cc_task_id IS NOT NULL
      ORDER BY updated_at ASC LIMIT ?`,
    [BATCH_LIMIT],
  ) as unknown as PublishQueueRow[];
  let followed = 0;
  for (const row of runningRows) {
    const task = queryOne<{ status: string; block_reason?: string | null }>(
      'SELECT status, block_reason FROM tasks WHERE id = ?',
      [row.cc_task_id],
    );
    if (!task) continue;
    followed++;
    if (task.status === 'done') {
      run(
        `UPDATE publish_queue SET status = 'published', completed_at = ?, updated_at = ?
          WHERE id = ? AND cc_task_id = ? AND status = 'running'`,
        [nowIso, nowIso, row.id, row.cc_task_id],
      );
      broadcast({ type: `publish_state:${row.company_id}`, payload: { id: row.id, status: 'published' } });
    } else if (task.status === 'blocked') {
      run(
        `UPDATE publish_queue SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND cc_task_id = ? AND status = 'running'`,
        [`task blocked: ${task.block_reason || 'unknown'}`, nowIso, nowIso, row.id, row.cc_task_id],
      );
      broadcast({ type: `publish_state:${row.company_id}`, payload: { id: row.id, status: 'failed' } });
    }
  }

  // ── CLAIM: queued/retrying rows past their retry deadline ─────────────────
  const claimable = queryAll<PublishQueueRow>(
    `SELECT * FROM publish_queue
      WHERE status IN ('queued','retrying')
        AND (retry_at IS NULL OR retry_at <= ?)
      ORDER BY created_at ASC LIMIT ?`,
    [nowIso, BATCH_LIMIT],
  ) as unknown as PublishQueueRow[];
  if (claimable.length === 0) {
    return { scanned: runningRows.length, dispatched: 0, retried: 0, failed: 0, followed };
  }

  const workerId = `social-publish-dispatcher-${process.pid}`;
  let dispatched = 0;
  let retried = 0;
  let failed = 0;

  for (const row of claimable) {
    try {
      // CAS claim: only a row still queued/retrying with no live lease wins.
      // The lease owner + expiry stamped here ARE the fencing token pair.
      const leaseExpiresAt = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
      const claim = run(
        `UPDATE publish_queue
            SET status = 'running', lease_owner = ?, lease_expires_at = ?,
                attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?,
                started_at = COALESCE(started_at, ?)
          WHERE id = ? AND status IN ('queued','retrying')
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        [workerId, leaseExpiresAt, nowIso, nowIso, nowIso, row.id, nowIso],
      );
      if (claim.changes !== 1) continue; // another worker won the row

      throwIfJobLeaseLost();

      // ── INGEST: canonical task, company-bound, idempotent ────────────────
      const platforms = parsePlatforms(row.platforms);
      const idempotencyKey =
        row.idempotency_key ||
        publishIdempotencyKey({
          companyId: row.company_id,
          taskId: row.task_id,
          topic: row.topic,
          platforms,
        });

      // Persist the key BEFORE ingest so any crash path still dedupes.
      run(`UPDATE publish_queue SET idempotency_key = ?, updated_at = ? WHERE id = ?`, [
        idempotencyKey,
        nowIso,
        row.id,
      ]);

      let createdTaskId: string | null = row.task_id; // a pre-bound task is reused
      let deduped = false;
      if (!createdTaskId) {
        const result = await createTaskCore(
          {
            title: `Social publish: ${row.topic}`.slice(0, 500),
            description:
              `Skill 35 publishing cycle queued from the dashboard (publish_queue ${row.id}).\n` +
              `Platforms: ${platforms.join(', ')}\nSchedule: ${row.schedule || 'auto'}\n` +
              `Requested by: ${row.run_id || 'dashboard'}`,
            status: 'backlog',
            priority: 'medium',
            assigned_agent_id: null,
            created_by_agent_id: null,
            workspace_id: null,
            department: 'social-media',
            eventMessage: `Social publish queued: ${row.topic} [ingest:${idempotencyKey}]`,
            idempotency_key: idempotencyKey,
            idempotency_company_id: row.company_id,
            source: 'social-publish-dispatcher',
          },
          { origin: 'social-publish-dispatcher' },
        );
        if (!result) throw new Error('task_ingest_failed');
        createdTaskId = result.task.id;
        deduped = result.deduped;

        // Persist linkage BEFORE dispatch acknowledgement (F03 required
        // outcome: restart mid-dispatch → persisted linkage survives).
        run(`UPDATE publish_queue SET cc_task_id = ?, updated_at = ? WHERE id = ?`, [
          createdTaskId,
          nowIso,
          row.id,
        ]);
      }

      // ── DISPATCH: canonical task-dispatcher (full guard chain) ───────────
      let outcome: Awaited<ReturnType<typeof autoDispatchTask>>;
      try {
        outcome = await autoDispatchTask(createdTaskId, 'social-publish-dispatcher');
      } catch (dispatchErr) {
        // autoDispatchTask is fire-and-forget and normally never throws; a
        // throw here is a pipeline error — same retry contract as 'failed'.
        outcome = { status: 'failed', reason: (dispatchErr as Error).message };
      }

      if (outcome.status === 'acknowledged' || outcome.status === 'unknown') {
        // Unknown acceptance deliberately RETAINS capacity (the execution
        // module's contract) — the row keeps its linkage either way. Persist
        // the execution id when the dispatcher surfaced one; otherwise read
        // the latest execution for the task (reserveExecution owns identity).
        let executionId = outcome.executionId ?? null;
        if (!executionId) {
          executionId = latestExecution(createdTaskId)?.id ?? null;
        }
        run(
          `UPDATE publish_queue SET cc_task_id = ?, cc_execution_id = ?, lease_owner = NULL,
             lease_expires_at = NULL, retry_at = NULL, error = NULL, updated_at = ?
           WHERE id = ?`,
          [createdTaskId, executionId, nowIso, row.id],
        );
        dispatched++;
        // 'unknown' is reconciliation, not a new send — execution-attempts
        // quarantines it until positive evidence, and the link-follow above
        // keeps the row truthful. Row status stays 'running' (work in flight).
        if (outcome.status === 'unknown') {
          run(`UPDATE publish_queue SET error = 'dispatch_acceptance_unknown', updated_at = ? WHERE id = ?`, [nowIso, row.id]);
        }
        broadcast({
          type: `publish_state:${row.company_id}`,
          payload: { id: row.id, status: 'running', task_id: createdTaskId, execution_id: executionId },
        });
        continue;
      }

      // held/failed → attempt accounting. Past the cap: failed (visible).
      const attemptCount = (row.attempt_count ?? 0) + 1;
      if (attemptCount >= MAX_ATTEMPTS && !deduped) {
        run(
          `UPDATE publish_queue SET status = 'failed', error = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
          [`dispatch ${outcome.status}: ${outcome.reason} (attempt ${attemptCount}/${MAX_ATTEMPTS})`, nowIso, row.id],
        );
        failed++;
        try {
          notifySystem(
            `Skill 35 publish ${row.id} (topic "${row.topic}") FAILED after ${attemptCount} attempts: ${outcome.reason}`,
            { agent: 'social-publish-dispatcher', action: 'publish_failed' },
          );
        } catch { /* best-effort */ }
        continue;
      }
      const retryAt = new Date(Date.now() + backoffSeconds(attemptCount) * 1000).toISOString();
      run(
        `UPDATE publish_queue SET status = 'retrying', retry_at = ?, error = ?,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
        [retryAt, `dispatch ${outcome.status}: ${outcome.reason}`, nowIso, row.id],
      );
      retried++;
    } catch (rowErr) {
      // Never let one poisoned row kill the sweep. Release the lease and
      // retry later, bounded by MAX_ATTEMPTS.
      const attemptCount = (row.attempt_count ?? 0) + 1;
      if (attemptCount >= MAX_ATTEMPTS) {
        run(
          `UPDATE publish_queue SET status = 'failed', error = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
          [`consumer error: ${(rowErr as Error).message}`, nowIso, row.id],
        );
        failed++;
      } else {
        const retryAt = new Date(Date.now() + backoffSeconds(attemptCount) * 1000).toISOString();
        run(
          `UPDATE publish_queue SET status = 'retrying', retry_at = ?, error = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
          [retryAt, (rowErr as Error).message, nowIso, row.id],
        );
        retried++;
      }
    }
  }

  return { scanned: claimable.length + runningRows.length, dispatched, retried, failed, followed };
}

/**
 * Overdue sweep — makes overdue state actionable WITHOUT operator resets
 * (D-F03-01 repair: overdue rows were terminal — status 'overdue' matched no
 * claim path, so post-restart resume needed a manual UPDATE to queued).
 *
 * For each row the read-side derivation flags as overdue:
 *   - attempts remaining → status back to 'retrying' with retry_at=now so the
 *     very next dispatcher tick reclaims it (bounded by MAX_ATTEMPTS; the
 *     lease is cleared so the CAS claim path can take it);
 *   - attempts exhausted → terminal 'failed' with a visible error (never
 *     silently re-looped, never silently dropped).
 * overdue_since stamps the FIRST flag time (operator-alert dedup guard) and
 * the operator is notified ONCE per row. Read-side derivation stays the
 * source of truth for display.
 */
export async function runSocialPublishOverdueSweep(): Promise<{ overdue: number; requeued: number; exhausted: number }> {
  const now = new Date();
  const nowIso = now.toISOString();
  const rows = queryAll<PublishQueueRow>(
    `SELECT * FROM publish_queue WHERE status IN ('queued','running','retrying') ORDER BY created_at ASC LIMIT 100`,
  ) as unknown as PublishQueueRow[];
  let overdue = 0;
  let requeued = 0;
  let exhausted = 0;
  for (const row of rows) {
    let isOverdue =
      deriveQueueItemState({
        status: row.status,
        created_at: row.created_at,
        lease_expires_at: row.lease_expires_at,
        cc_task_id: row.cc_task_id,
        retry_at: row.retry_at,
        now,
      }) === 'overdue';
    if (!isOverdue && row.status === 'retrying') {
      // A retrying row past its deadline on an old intent means the consumer
      // is stopped again (the live dispatcher claims these every tick).
      const ageMs = now.getTime() - new Date(row.created_at).getTime();
      const deadlinePassed = !row.retry_at || new Date(row.retry_at).getTime() <= now.getTime();
      isOverdue = deadlinePassed && ageMs > OVERDUE_MINUTES * 60_000;
    }
    if (!isOverdue) continue;
    const firstFlag = !row.overdue_since;
    const attempts = row.attempt_count ?? 0;
    if (attempts >= MAX_ATTEMPTS) {
      const claimed = run(
        `UPDATE publish_queue SET status = 'failed',
           error = COALESCE(error, '') || ' [overdue: attempt cap exhausted]',
           overdue_since = COALESCE(overdue_since, ?), updated_at = ?
          WHERE id = ? AND status = ?`,
        [nowIso, nowIso, row.id, row.status],
      );
      if (claimed.changes === 1) {
        overdue++;
        exhausted++;
        if (firstFlag) {
          try {
            notifySystem(
              `Skill 35 publish ${row.id} is OVERDUE and out of attempts — marked failed. Topic: "${row.topic}".`,
              { agent: 'social-publish-dispatcher', action: 'publish_overdue_exhausted' },
            );
          } catch { /* best-effort */ }
        }
      }
      continue;
    }
    const claimed = run(
      `UPDATE publish_queue SET status = 'retrying', retry_at = ?,
         overdue_since = COALESCE(overdue_since, ?),
         lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = ?`,
      [nowIso, nowIso, nowIso, row.id, row.status],
    );
    if (claimed.changes === 1) {
      overdue++;
      requeued++;
      if (firstFlag) {
        try {
          notifySystem(
            `Skill 35 publish ${row.id} is OVERDUE — the publish consumer is stopped or the dispatch stalled. Topic: "${row.topic}". Requeued for automatic resume.`,
            { agent: 'social-publish-dispatcher', action: 'publish_overdue' },
          );
        } catch { /* best-effort */ }
      }
    }
  }
  return { overdue, requeued, exhausted };
}