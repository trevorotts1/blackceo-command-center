/**
 * launch-outbox.ts — F23.10 / F23.14: the durable launch event outbox.
 *
 * A local run keeps working when the Command Center is unreachable: its events
 * are written here first and delivered later. The outbox is the ONLY place
 * delivery state lives, so a report can always distinguish:
 *
 *   queued               — waiting for its first attempt
 *   accepted             — the Command Center acknowledged it (delivered)
 *   retrying             — attempted, failed, will be tried again
 *   permanently_rejected — dead-lettered after `maxAttempts`, or a permanent
 *                          failure. It is NOT "sent", even though no retry
 *                          remains.
 *
 * Correctness rules:
 *   - enqueue is idempotent on `event_id` (at-least-once producers can re-send);
 *   - a rewrite of a still-undelivered event is atomic (same transaction as the
 *     payload/version replacement) and an ACCEPTED event is immutable;
 *   - claim → deliver → complete/retry uses a claim token CAS, so two consumers
 *     draining at once cannot deliver the same event twice;
 *   - ordering is `(plan_version, sequence)`, then creation time;
 *   - a CC outage reports synchronization unavailable/stale and never claims a
 *     remote acceptance that did not happen.
 */

import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { ensureLaunchDomainSchema } from './launch-domain';

export type OutboxStatus = 'queued' | 'accepted' | 'retrying' | 'permanently_rejected';

export interface LaunchOutboxRow {
  event_id: string;
  run_id: string;
  skill: number;
  launch_id: string;
  plan_version: number;
  sequence: number;
  payload_json: string;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueInput {
  eventId: string;
  runId: string;
  skill: number;
  launchId: string;
  planVersion: number;
  sequence?: number;
  payload: unknown;
}

export type EnqueueResult =
  | { status: 'queued'; eventId: string; sequence: number }
  | { status: 'duplicate'; eventId: string; sequence: number }
  | { status: 'rejected'; eventId: string; reason: string };

const MAX_CLAIM_LEASE_MS = 5 * 60_000;

function nowIso(now?: number): string {
  return new Date(now ?? Date.now()).toISOString();
}

/**
 * Append one event to the outbox. Idempotent on `event_id`: an identical
 * re-send is a duplicate and writes nothing. A re-send whose payload DIFFERS is
 * rewritten only while the event is still undelivered; an accepted event is
 * immutable and a different payload is rejected.
 */
export function enqueueLaunchEvent(input: EnqueueInput, now?: number): EnqueueResult {
  ensureLaunchDomainSchema();
  const at = nowIso(now);
  const serialized = JSON.stringify(input.payload);
  return transaction(() => {
    const existing = queryOne<LaunchOutboxRow>(
      `SELECT * FROM launch_event_outbox WHERE event_id = ?`,
      [input.eventId],
    );
    if (existing) {
      if (existing.payload_json === serialized && existing.plan_version === input.planVersion) {
        return { status: 'duplicate' as const, eventId: input.eventId, sequence: existing.sequence };
      }
      if (existing.status === 'accepted') {
        return {
          status: 'rejected' as const,
          eventId: input.eventId,
          reason: 'an accepted outbox event is immutable; a different payload cannot replace it',
        };
      }
      run(
        `UPDATE launch_event_outbox
            SET payload_json = ?, plan_version = ?, status = 'queued', next_attempt_at = NULL,
                last_error = NULL, claim_token = NULL, claimed_at = NULL, updated_at = ?
          WHERE event_id = ? AND status IN ('queued','retrying','permanently_rejected')`,
        [serialized, input.planVersion, at, input.eventId],
      );
      return { status: 'queued' as const, eventId: input.eventId, sequence: existing.sequence };
    }
    const sequence =
      input.sequence ??
      (queryOne<{ n: number | null }>(
        `SELECT MAX(sequence) AS n FROM launch_event_outbox WHERE run_id = ?`,
        [input.runId],
      )?.n ?? 0) + 1;
    run(
      `INSERT INTO launch_event_outbox
         (event_id, run_id, skill, launch_id, plan_version, sequence, payload_json, status,
          attempts, next_attempt_at, last_error, claim_token, claimed_at, accepted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      [
        input.eventId,
        input.runId,
        input.skill,
        input.launchId,
        input.planVersion,
        sequence,
        serialized,
        at,
        at,
      ],
    );
    return { status: 'queued' as const, eventId: input.eventId, sequence };
  });
}

export interface ClaimOptions {
  now?: number;
  limit?: number;
  /** Reclaim a claim this old (a consumer that died mid-delivery). */
  leaseMs?: number;
}

/**
 * Atomically claim due events for delivery, ordered by plan version then
 * sequence. A claimed row carries a fresh `claim_token`; the CAS in the UPDATE
 * means two consumers cannot both win the same row.
 */
export function claimDueEvents(options: ClaimOptions = {}): LaunchOutboxRow[] {
  ensureLaunchDomainSchema();
  const now = options.now ?? Date.now();
  const at = nowIso(now);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const leaseMs = Math.max(1_000, Math.min(options.leaseMs ?? MAX_CLAIM_LEASE_MS, 3_600_000));
  const leaseCutoff = nowIso(now - leaseMs);
  const claimed: LaunchOutboxRow[] = [];
  transaction(() => {
    // Reclaim a stale claim (consumer crashed mid-delivery). Attempts already
    // counted; the next claim increments again, so a crash loop cannot hide.
    run(
      `UPDATE launch_event_outbox
          SET claim_token = NULL, claimed_at = NULL, status = 'retrying', updated_at = ?
        WHERE claim_token IS NOT NULL AND claimed_at IS NOT NULL AND claimed_at < ?
          AND status IN ('queued','retrying')`,
      [at, leaseCutoff],
    );
    const due = queryAll<LaunchOutboxRow>(
      `SELECT * FROM launch_event_outbox
        WHERE status IN ('queued','retrying')
          AND claim_token IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY plan_version ASC, sequence ASC, created_at ASC
        LIMIT ?`,
      [at, limit],
    );
    for (const row of due) {
      const token = `claim-${row.event_id}-${now}-${claimed.length}`;
      const updated = run(
        `UPDATE launch_event_outbox
            SET claim_token = ?, claimed_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE event_id = ? AND claim_token IS NULL
            AND status IN ('queued','retrying') AND attempts = ?`,
        [token, at, at, row.event_id, row.attempts],
      );
      if (updated.changes === 0) continue;
      claimed.push({ ...row, claim_token: token, claimed_at: at, attempts: row.attempts + 1 });
    }
  });
  return claimed;
}

/** Mark a claimed event accepted by the Command Center. */
export function completeEvent(
  eventId: string,
  claimToken: string,
  now?: number,
): boolean {
  const at = nowIso(now);
  const result = run(
    `UPDATE launch_event_outbox
        SET status = 'accepted', accepted_at = ?, claim_token = NULL, claimed_at = NULL,
            next_attempt_at = NULL, last_error = NULL, updated_at = ?
      WHERE event_id = ? AND claim_token = ?`,
    [at, at, eventId, claimToken],
  );
  return result.changes === 1;
}

export type RetryResult = { status: 'retrying'; attempts: number; nextAttemptAt: string } | { status: 'permanently_rejected'; attempts: number };

/**
 * Record a failed delivery. After `maxAttempts` the event is DEAD-LETTERED:
 * it keeps its row (history is preserved), but it is no longer sent and must
 * never be counted as delivered.
 */
export function retryEvent(
  eventId: string,
  claimToken: string,
  error: string,
  options: { now?: number; maxAttempts?: number; backoffMs?: number } = {},
): RetryResult | null {
  const now = options.now ?? Date.now();
  const at = nowIso(now);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const backoffMs = Math.max(0, options.backoffMs ?? 30_000);
  return transaction(() => {
    const row = queryOne<LaunchOutboxRow>(
      `SELECT * FROM launch_event_outbox WHERE event_id = ? AND claim_token = ?`,
      [eventId, claimToken],
    );
    if (!row) return null;
    if (row.attempts >= maxAttempts) {
      run(
        `UPDATE launch_event_outbox
            SET status = 'permanently_rejected', last_error = ?, claim_token = NULL,
                claimed_at = NULL, next_attempt_at = NULL, updated_at = ?
          WHERE event_id = ? AND claim_token = ?`,
        [`${error} (exhausted after ${row.attempts} attempts)`, at, eventId, claimToken],
      );
      return { status: 'permanently_rejected' as const, attempts: row.attempts };
    }
    const nextAttemptAt = nowIso(now + backoffMs * row.attempts);
    run(
      `UPDATE launch_event_outbox
          SET status = 'retrying', last_error = ?, claim_token = NULL, claimed_at = NULL,
              next_attempt_at = ?, updated_at = ?
        WHERE event_id = ? AND claim_token = ?`,
      [error, nextAttemptAt, at, eventId, claimToken],
    );
    return { status: 'retrying' as const, attempts: row.attempts, nextAttemptAt };
  });
}

export interface DrainResult {
  claimed: number;
  delivered: number;
  retrying: number;
  permanentlyRejected: number;
}

export interface DrainOptions {
  now?: number;
  limit?: number;
  maxAttempts?: number;
  backoffMs?: number;
  /** Deliver one event. Return ok:false with permanent:true to dead-letter now. */
  deliver: (row: LaunchOutboxRow) =>
    | { ok: true }
    | { ok: false; error: string; permanent?: boolean };
}

/**
 * Drain the outbox in two phases: an atomic claim, then one delivery attempt
 * per claimed event, then a CAS completion/retry. Concurrent producers can
 * enqueue during either phase without losing or duplicating an event; a
 * concurrent consumer cannot claim a row already held by this drain.
 */
export function drainLaunchOutbox(options: DrainOptions): DrainResult {
  const claimed = claimDueEvents({
    now: options.now,
    limit: options.limit,
  });
  const result: DrainResult = {
    claimed: claimed.length,
    delivered: 0,
    retrying: 0,
    permanentlyRejected: 0,
  };
  for (const row of claimed) {
    let outcome: { ok: true } | { ok: false; error: string; permanent?: boolean };
    try {
      outcome = options.deliver(row);
    } catch (error) {
      outcome = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (outcome.ok) {
      if (completeEvent(row.event_id, row.claim_token!, options.now)) result.delivered += 1;
      continue;
    }
    if (outcome.permanent) {
      retryEvent(row.event_id, row.claim_token!, outcome.error, {
        now: options.now,
        maxAttempts: 1,
        backoffMs: 0,
      });
      result.permanentlyRejected += 1;
      continue;
    }
    const retried = retryEvent(row.event_id, row.claim_token!, outcome.error, {
      now: options.now,
      maxAttempts: options.maxAttempts,
      backoffMs: options.backoffMs,
    });
    if (retried?.status === 'permanently_rejected') result.permanentlyRejected += 1;
    else result.retrying += 1;
  }
  return result;
}

export interface OutboxSyncState {
  available: boolean;
  /** True when the outbox holds undelivered work older than `staleAfterMs`. */
  stale: boolean;
  queued: number;
  retrying: number;
  accepted: number;
  permanently_rejected: number;
  /** The ONLY number that may be reported as sent. */
  sent: number;
  dead_lettered: number;
  last_accepted_at: string | null;
  plan_version: number | null;
  /** A local outage never lets a report claim the Command Center accepted anything. */
  remote_acceptance_claimed: false;
  error?: string;
}

const DEFAULT_STALE_AFTER_MS = 15 * 60_000;

/**
 * Report synchronization honestly. `sent` counts ACCEPTED events only:
 * queued, retrying and permanently rejected are never folded into it.
 */
export function outboxSyncState(options: { now?: number; staleAfterMs?: number } = {}): OutboxSyncState {
  const now = options.now ?? Date.now();
  const staleAfterMs = Math.max(1_000, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  try {
    ensureLaunchDomainSchema();
    const rows = queryAll<{ status: OutboxStatus; n: number }>(
      `SELECT status, COUNT(*) AS n FROM launch_event_outbox GROUP BY status`,
    );
    const counts: Record<OutboxStatus, number> = {
      queued: 0,
      accepted: 0,
      retrying: 0,
      permanently_rejected: 0,
    };
    for (const row of rows) counts[row.status] = row.n;
    const lastAccepted = queryOne<{ at: string | null }>(
      `SELECT MAX(accepted_at) AS at FROM launch_event_outbox WHERE status = 'accepted'`,
    );
    const planVersion = queryOne<{ v: number | null }>(
      `SELECT MAX(plan_version) AS v FROM launch_event_outbox`,
    );
    const oldestUndelivered = queryOne<{ at: string | null }>(
      `SELECT MIN(created_at) AS at FROM launch_event_outbox
        WHERE status IN ('queued','retrying','permanently_rejected')`,
    );
    const stale =
      oldestUndelivered?.at !== null &&
      oldestUndelivered?.at !== undefined &&
      now - Date.parse(oldestUndelivered.at) > staleAfterMs;
    return {
      available: true,
      stale,
      queued: counts.queued,
      retrying: counts.retrying,
      accepted: counts.accepted,
      permanently_rejected: counts.permanently_rejected,
      sent: counts.accepted,
      dead_lettered: counts.permanently_rejected,
      last_accepted_at: lastAccepted?.at ?? null,
      plan_version: planVersion?.v ?? null,
      remote_acceptance_claimed: false,
    };
  } catch (error) {
    return {
      available: false,
      stale: true,
      queued: 0,
      retrying: 0,
      accepted: 0,
      permanently_rejected: 0,
      sent: 0,
      dead_lettered: 0,
      last_accepted_at: null,
      plan_version: null,
      remote_acceptance_claimed: false,
      error: error instanceof Error ? error.message : 'launch outbox unavailable',
    };
  }
}

/** Read one event (tests + diagnostics). */
export function readOutboxEvent(eventId: string): LaunchOutboxRow | null {
  ensureLaunchDomainSchema();
  return (
    queryOne<LaunchOutboxRow>(`SELECT * FROM launch_event_outbox WHERE event_id = ?`, [eventId]) ??
    null
  );
}
