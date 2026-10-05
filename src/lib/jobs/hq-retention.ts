/**
 * Headquarters retention — age-only bounded maintenance (unit B06, milestone V04).
 *
 * Authority: SPEC.md revision 4, section S6 ("Storage and retention"). The frozen
 * TypeScript contracts live in `src/lib/hq/types.ts` (P01); this job owns the
 * periodic sweep only and introduces no second writer of Headquarters activity.
 *
 * WHAT THIS JOB OWNS
 * ------------------
 * Four age rules, each with the SPEC's own numbers:
 *
 *   1. hq_activity          age sweep, 30 days by `received_at`; at most 500
 *                           age-expired oldest rows per minute; the per-company
 *                           `pruned_through_seq` watermark is updated in the
 *                           SAME transaction as the delete.
 *   2. hq_activity_receipts expire 48 hours after `accepted_at` — the FIRST
 *                           acceptance. The job never touches `accepted_at`, so
 *                           a retry can never extend a receipt's life.
 *   3. hq_chat_turns        at 30 days past `terminal_at`, redact message/reply
 *                           content and stamp `content_expired_at`; the
 *                           ID/hash/state tombstone stays until 90 days, when
 *                           the row is removed. Only TERMINAL rows are ever
 *                           read, redacted or pruned. Pending/reconciling turns
 *                           are not auto-pruned at any age.
 *   4. hq_chat_sessions     close after 30 idle days; the closed-session
 *                           tombstone is removed at 90 days, and only when no
 *                           turn rows remain for it, so a delete can never
 *                           orphan — or silently cascade — a turn.
 *
 * WHAT THIS JOB IS NOT
 * --------------------
 * It never enforces an insertion-time bound. The hard 5,000-row / 32 MiB feed cap
 * and the 100,000-unexpired-receipt capacity rule belong to the append path
 * (B05/B07) and run inside the writer's own transaction; a sweeper that competed
 * with them could evict a dedup key still inside its replay window. It touches
 * no table outside the four families above, never removes an underlying task or
 * message, and leaves global `seq` gaps untouched (they are legal, S6).
 *
 * CLOCK BEHAVIOUR
 * ---------------
 * Every cutoff in a run is derived from ONE clock read at the top of the run, so
 * no two steps can disagree about "now". Comparisons are strictly `<` against a
 * bound, and `sqlTime()` folds both stored timestamp dialects (ISO-'T'-'Z' and
 * SQLite space form) before comparing, so a naive byte-sort can never decide a
 * window. A NULL or unparseable timestamp matches nothing and is never deleted.
 * A rolled-back clock moves every cutoff backwards and can therefore only make
 * the sweep SMALLER; a forward-skewed row (timestamp in the future) is likewise
 * never deleted.
 *
 * SCHEDULER
 * ---------
 * `HQ_RETENTION_CRON_EXPR` is exported for the one existing scheduler
 * registration; the registration itself is A01's (assemble) edit, not this
 * unit's. The sweep is bounded per run, so a missed tick costs one batch, never
 * a backlog: each step is capped by a LIMIT, and a failure in one step is
 * logged and skipped rather than aborting the others.
 *
 * Kill flag:
 *   DISABLE_HQ_RETENTION=1|true — skip the sweep entirely, delete nothing, and
 *   report a skippedReason so the scheduler records the tick as 'disabled'
 *   rather than a false-green 'ok' (same contract as db-retention).
 */

import { queryAll, queryOne, run, sqlTime, timeNow, transaction } from '@/lib/db';
import type { HqChatTurnState } from '@/lib/hq/types';

/** Once per minute: the SPEC's feed rate limit ("at most 500 ... per minute")
 *  is only met if the sweep itself runs on the minute. */
export const HQ_RETENTION_CRON_EXPR = '* * * * *';

// ── Retention rules (SPEC S6) ───────────────────────────────────────────────

const FEED_RETENTION_DAYS = 30;
/** S6: "removes at most 500 age-expired oldest rows per minute". */
const FEED_SWEEP_MAX_ROWS = 500;
const RECEIPT_RETENTION_HOURS = 48;
const TURN_CONTENT_REDACT_DAYS = 30;
const TURN_TOMBSTONE_DAYS = 90;
const SESSION_IDLE_CLOSE_DAYS = 30;
const SESSION_TOMBSTONE_DAYS = 90;

/** Bounded batch for the steps the SPEC gives no rate for — the repo's own
 *  db-retention batch size, so one sweep can never hold a long write lock. */
const MAINTENANCE_BATCH_ROWS = 5000;

/**
 * S9's eight turn states split into prunable and untouched. `replied`,
 * `failed_unsent`, `refused` and `unresolved` are terminal (they have a
 * `terminal_at`); `queued`, `sending`, `awaiting_reply` and `reconciling` may
 * still produce a result and are never redacted or pruned.
 */
const HQ_TERMINAL_TURN_STATES: readonly HqChatTurnState[] = [
  'replied',
  'failed_unsent',
  'refused',
  'unresolved',
];

/** Written over redacted content; `content_expired_at` records WHEN, and this
 *  marker keeps a redacted row distinguishable from a genuinely empty message. */
const REDACTED_CONTENT = '[expired]';

const HQ_CHAT_TABLE = 'hq_chat_turns';
const HQ_SESSION_TABLE = 'hq_chat_sessions';

// ── Result shape ────────────────────────────────────────────────────────────

export interface HqRetentionDeleted {
  /** hq_activity rows age-evicted (cap 500 per run; insertion-time eviction is B05's). */
  activity: number;
  /** hq_activity_receipts rows past 48 hours after first acceptance. */
  receipts: number;
  /** hq_chat_turns rows whose message/reply content was redacted at 30 days. */
  turn_contents_redacted: number;
  /** hq_chat_turns tombstone rows removed at 90 days. */
  turns: number;
  /** hq_chat_sessions rows closed after 30 idle days. */
  sessions_closed: number;
  /** hq_chat_sessions tombstone rows removed at 90 days. */
  sessions: number;
}

export interface HqRetentionResult {
  /** ISO timestamp the job started. */
  ranAt: string;
  /** Set only on a deliberate skip (kill flag). */
  skippedReason?: string;
  /** Rows changed per family; every count is work this run actually performed. */
  deleted: HqRetentionDeleted;
  /** Wall-clock milliseconds the run took. */
  durationMs: number;
}

function emptyDeleted(): HqRetentionDeleted {
  return {
    activity: 0,
    receipts: 0,
    turn_contents_redacted: 0,
    turns: 0,
    sessions_closed: 0,
    sessions: 0,
  };
}

/** One log line for a completed run, so the scheduler registration (A01) and
 *  any operator reading the console see the same numbers the receipt carries. */
export function formatHqRetentionSummary(result: HqRetentionResult): string {
  const d = result.deleted;
  return (
    `deleted activity=${d.activity} receipts=${d.receipts} ` +
    `turn_contents=${d.turn_contents_redacted} turns=${d.turns} ` +
    `sessions_closed=${d.sessions_closed} sessions=${d.sessions} ` +
    `in ${(result.durationMs / 1000).toFixed(1)}s`
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isoDaysAgo(fromMs: number, days: number): string {
  return new Date(fromMs - days * 86_400_000).toISOString();
}

function isoHoursAgo(fromMs: number, hours: number): string {
  return new Date(fromMs - hours * 3_600_000).toISOString();
}

/** A fixture or a half-migrated box may not carry the HQ tables yet (B01 owns
 *  the migration). A missing table is zero work, never an exception. */
function tableExists(name: string): boolean {
  try {
    return (
      (queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`,
        [name],
      )?.n ?? 0) > 0
    );
  } catch {
    return false;
  }
}

/** Run one step; a failure there must never abort the sweep's other families. */
function step(label: string, fn: () => number): number {
  try {
    return fn();
  } catch (err) {
    console.warn(`[hq-retention] ${label} failed:`, (err as Error).message);
    return 0;
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

// ── Step 1 — expired dedup receipts (48 hours after first acceptance) ───────

function pruneExpiredReceipts(cutoffIso: string): number {
  if (!tableExists('hq_activity_receipts')) return 0;
  // `accepted_at` is never written here. A NULL/unparseable accepted_at folds to
  // NULL in sqlTime() and matches nothing, so a receipt that was never accepted
  // is left alone rather than silently freed for reuse.
  return run(
    `DELETE FROM hq_activity_receipts
      WHERE rowid IN (
        SELECT rowid FROM hq_activity_receipts
         WHERE ${sqlTime('accepted_at')} < ${sqlTime('?')}
         LIMIT ?
      )`,
    [cutoffIso, MAINTENANCE_BATCH_ROWS],
  ).changes;
}

// ── Step 2 — activity feed age sweep + watermark ────────────────────────────

function pruneExpiredActivity(cutoffIso: string, nowIso: string): number {
  if (!tableExists('hq_activity') || !tableExists('hq_activity_state')) return 0;

  // The globally oldest expired rows, so the 500-row rate is spent where the
  // data is oldest regardless of which company owns it. `received_at` is set by
  // the receiver at insert and `seq` is assigned by the same insert, so both
  // orders agree; a company's selected rows are its lowest expired seqs.
  // Companies with no state row are excluded: a prune without a watermark to
  // record it would leave the feed cursor lying.
  const victims = queryAll<{ seq: number; company_id: string }>(
    `SELECT seq, company_id FROM hq_activity
      WHERE ${sqlTime('received_at')} < ${sqlTime('?')}
        AND company_id IN (SELECT company_id FROM hq_activity_state)
      ORDER BY seq ASC
      LIMIT ?`,
    [cutoffIso, FEED_SWEEP_MAX_ROWS],
  );
  if (victims.length === 0) return 0;

  const byCompany = new Map<string, number[]>();
  for (const v of victims) {
    const seqs = byCompany.get(v.company_id);
    if (seqs) seqs.push(v.seq);
    else byCompany.set(v.company_id, [v.seq]);
  }

  return transaction(() => {
    let evicted = 0;
    for (const [companyId, seqs] of byCompany) {
      const maxEvicted = seqs[seqs.length - 1];
      evicted += run(
        `DELETE FROM hq_activity WHERE company_id = ? AND seq IN (${placeholders(seqs.length)})`,
        [companyId, ...seqs],
      ).changes;

      // Watermark, never past the company's oldest RETAINED row: a forward page
      // returns `seq > cursor`, so a retained row below the watermark would
      // become unreachable. Under a monotone clock this equals maxEvicted; under
      // a clock rollback it stops short instead of skipping live data. Landing
      // in a seq gap is fine — gaps are legal.
      const oldestRetained =
        queryOne<{ m: number | null }>(
          `SELECT MIN(seq) AS m FROM hq_activity WHERE company_id = ?`,
          [companyId],
        )?.m ?? null;
      const watermark =
        oldestRetained === null ? maxEvicted : Math.min(maxEvicted, oldestRetained - 1);

      run(
        `UPDATE hq_activity_state
            SET pruned_through_seq = ?, updated_at = ?
          WHERE company_id = ? AND pruned_through_seq < ?`,
        [watermark, nowIso, companyId, watermark],
      );
    }
    return evicted;
  });
}

// ── Step 3/4 — private turn content redaction, then tombstone removal ───────

function redactExpiredTurnContents(cutoffIso: string, nowIso: string): number {
  if (!tableExists(HQ_CHAT_TABLE)) return 0;
  return run(
    `UPDATE hq_chat_turns
        SET message_text = ?, reply_text = NULL, content_expired_at = ?
      WHERE rowid IN (
        SELECT rowid FROM hq_chat_turns
         WHERE state IN (${placeholders(HQ_TERMINAL_TURN_STATES.length)})
           AND terminal_at IS NOT NULL
           AND ${sqlTime('terminal_at')} < ${sqlTime('?')}
           AND content_expired_at IS NULL
         LIMIT ?
      )`,
    [
      REDACTED_CONTENT,
      nowIso,
      ...HQ_TERMINAL_TURN_STATES,
      cutoffIso,
      MAINTENANCE_BATCH_ROWS,
    ],
  ).changes;
}

function pruneTurnTombstones(cutoffIso: string): number {
  if (!tableExists(HQ_CHAT_TABLE)) return 0;
  return run(
    `DELETE FROM hq_chat_turns
      WHERE rowid IN (
        SELECT rowid FROM hq_chat_turns
         WHERE state IN (${placeholders(HQ_TERMINAL_TURN_STATES.length)})
           AND terminal_at IS NOT NULL
           AND ${sqlTime('terminal_at')} < ${sqlTime('?')}
         LIMIT ?
      )`,
    [...HQ_TERMINAL_TURN_STATES, cutoffIso, MAINTENANCE_BATCH_ROWS],
  ).changes;
}

// ── Step 5/6 — close idle sessions, then remove session tombstones ──────────

function closeIdleSessions(cutoffIso: string, nowIso: string): number {
  if (!tableExists(HQ_SESSION_TABLE)) return 0;
  return run(
    `UPDATE hq_chat_sessions
        SET closed_at = ?
      WHERE rowid IN (
        SELECT rowid FROM hq_chat_sessions
         WHERE closed_at IS NULL
           AND ${sqlTime('last_activity_at')} < ${sqlTime('?')}
         LIMIT ?
      )`,
    [nowIso, cutoffIso, MAINTENANCE_BATCH_ROWS],
  ).changes;
}

function pruneSessionTombstones(cutoffIso: string): number {
  if (!tableExists(HQ_SESSION_TABLE) || !tableExists(HQ_CHAT_TABLE)) return 0;
  // NOT EXISTS keeps a session whose turn rows survive: deleting it would either
  // violate the turn→session foreign key or cascade away a turn the SPEC says is
  // not auto-pruned.
  return run(
    `DELETE FROM hq_chat_sessions
      WHERE rowid IN (
        SELECT s.rowid FROM hq_chat_sessions s
         WHERE s.closed_at IS NOT NULL
           AND ${sqlTime('s.closed_at')} < ${sqlTime('?')}
           AND NOT EXISTS (
                 SELECT 1 FROM hq_chat_turns t
                  WHERE t.company_id = s.company_id AND t.session_id = s.id
               )
         LIMIT ?
      )`,
    [cutoffIso, MAINTENANCE_BATCH_ROWS],
  ).changes;
}

// ── The sweep ───────────────────────────────────────────────────────────────

/**
 * One bounded retention pass. Idempotent: a second run in the same minute finds
 * no new expired rows and changes nothing.
 */
export async function runHqRetention(): Promise<HqRetentionResult> {
  const startedMs = Date.now();
  const ranAt = new Date(startedMs).toISOString();
  const deleted = emptyDeleted();

  if (process.env.DISABLE_HQ_RETENTION === '1' || process.env.DISABLE_HQ_RETENTION === 'true') {
    return {
      ranAt,
      skippedReason: 'DISABLE_HQ_RETENTION set',
      deleted,
      durationMs: Date.now() - startedMs,
    };
  }

  // ONE clock read for the whole run (see CLOCK BEHAVIOUR above).
  const nowIso = timeNow();
  const receiptsCutoff = isoHoursAgo(startedMs, RECEIPT_RETENTION_HOURS);
  const feedCutoff = isoDaysAgo(startedMs, FEED_RETENTION_DAYS);
  const turnContentCutoff = isoDaysAgo(startedMs, TURN_CONTENT_REDACT_DAYS);
  const turnTombstoneCutoff = isoDaysAgo(startedMs, TURN_TOMBSTONE_DAYS);
  const sessionIdleCutoff = isoDaysAgo(startedMs, SESSION_IDLE_CLOSE_DAYS);
  const sessionTombstoneCutoff = isoDaysAgo(startedMs, SESSION_TOMBSTONE_DAYS);

  // Receipts first, mirroring S6's "cleanup first removes expired receipts".
  deleted.receipts = step('receipt cleanup', () => pruneExpiredReceipts(receiptsCutoff));
  deleted.activity = step('activity age sweep', () =>
    pruneExpiredActivity(feedCutoff, nowIso),
  );
  deleted.turn_contents_redacted = step('turn content redaction', () =>
    redactExpiredTurnContents(turnContentCutoff, nowIso),
  );
  deleted.turns = step('turn tombstone removal', () => pruneTurnTombstones(turnTombstoneCutoff));
  deleted.sessions_closed = step('idle session close', () =>
    closeIdleSessions(sessionIdleCutoff, nowIso),
  );
  deleted.sessions = step('session tombstone removal', () =>
    pruneSessionTombstones(sessionTombstoneCutoff),
  );

  return { ranAt, deleted, durationMs: Date.now() - startedMs };
}
