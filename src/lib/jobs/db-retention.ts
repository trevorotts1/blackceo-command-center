/**
 * Daily database retention job — age out append-only diagnostic rows.
 *
 * WHY THIS EXISTS
 * ---------------
 * mission-control.db had NO retention on ANY append-only table. Measured on the
 * operator box on 2026-09-17, before the first cleanup:
 *
 *   presentation_stage_timings   539 MB   1.48 M rows in two days (looping runner)
 *   sse_event_log                 26 MB     43 k rows since 2026-08-18
 *   task_activities               23 MB     53 k rows since 2026-09-09
 *   events                        15 MB     73 k rows since 2026-08-10
 *
 * Nothing ever deleted an old row from any of them. This job makes the four
 * diagnostic tables self-limiting so the database stops growing without bound.
 *
 * WHAT IT NEVER TOUCHES
 * ---------------------
 * `tasks`, `task_events`, `task_deliverables`, the persona tables, the SOP
 * tables and `job_liveness` (one row per job — it is a state table, not a log).
 * Only the four tables named above are pruned, and only under the rules below.
 *
 * RETENTION RULES (each with an integer env override; a value below 1 or a
 * non-numeric value falls back to the default)
 * ---------------------------------------------------------------------------
 *   presentation_stage_timings   STAGE_TIMINGS_RETENTION_DAYS    default 30
 *     Pure per-run instrumentation. Every reader is a live dashboard over a
 *     recent run; nothing grades a box off month-old stage timings.
 *
 *   sse_event_log                SSE_EVENT_LOG_RETENTION_DAYS    default 14
 *     Replay buffer for the live feed. Its only reader is a reconnecting client
 *     asking for events since a last-seen id, which is minutes old at worst.
 *
 *   events                       EVENTS_RETENTION_DAYS           default 90
 *     RAISED FROM THE ORIGINALLY PROPOSED 60. The longest look-back any reader
 *     of `events` performs at DEFAULT settings is 60 days:
 *       src/lib/grading.ts:1168-1178  computeSopCoveragePrev() — the previous
 *       comparison window, `julianday('now') - julianday(e.created_at) <= ?`
 *       bound to `windowDays * 2`, where windowDays defaults to 30
 *       (src/app/api/company-health/route.ts:31-33).
 *     A 60-day retention would abut that reader EXACTLY, leaving zero headroom:
 *     the prior-period half of every grade trend would be permanently empty. 90
 *     days keeps a full 30 days of slack. Every other reader is far shorter —
 *     agent/department grades 30 days (src/lib/agents/performance.ts:475-488,
 *     src/lib/grading.ts:346-359), dispatch-hour histogram 48 hours
 *     (src/lib/operator/workforce-health.ts:280), and every cooldown/dedup key
 *     is hours (board-hygiene 7-day blend window, stale-sweep 24h re-ping dedup,
 *     digest and liveness cooldowns).
 *     ⚠️ A box that sets `gradingWindowDays` in company-config.json above 45, or
 *     that habitually calls /api/company-health?window=N with N > 45, must raise
 *     EVENTS_RETENTION_DAYS to at least 1.5 × that value.
 *
 *     LIVE CARDS ARE EXEMPT. An `events` row whose task_id points at a task that
 *     is NOT done and NOT archived is NEVER deleted, at any age. A live card
 *     keeps its whole history. Rows with task_id NULL (board-wide alerts,
 *     digests, cooldown markers) and rows whose task no longer exists are
 *     prunable.
 *
 *   task_activities              TASK_ACTIVITIES_RETENTION_DAYS  default 30
 *     ONLY for tasks that are done, archived, or no longer exist. A live task
 *     keeps every activity row regardless of age, because recent activity is a
 *     liveness signal for the sweeps.
 *     Longest reader look-back: src/lib/grading.ts:609-618 computeTokensPerTask()
 *     — `julianday('now') - julianday(ta.created_at) <= ?` bound to windowDays
 *     (default 30) and already restricted to `t.status = 'done'`. At the default
 *     the prune boundary and the reader boundary coincide exactly, so no row the
 *     default grade window reads is ever deleted. Raise the env on a box using a
 *     longer grading window.
 *     No sweep reads task_activities as a liveness signal — the stale sweep's
 *     hasRecentTaskActivity() (src/lib/jobs/stale-task-sweep.ts:262-274) queries
 *     `events` for the task over a 24h window despite its name, and 24h is far
 *     inside both retention rules. weekly-done-clear reads task_activities only
 *     as an EXISTS test with no time bound (src/lib/jobs/weekly-done-clear.ts:111),
 *     and it is an orphan-card guard on backlog/inbox cards — never a done or
 *     archived one — so no row this job deletes can flip that guard's answer.
 *
 * BOUNDED WORK
 * ------------
 * Deletes run in batches of DB_RETENTION_BATCH_SIZE rows (default 5000) inside a
 * loop, table by table, under a total wall-clock budget of
 * DB_RETENTION_BUDGET_SECONDS (default 60). When the budget runs out the job
 * stops where it is and reports `budgetExhausted: true`; the next night picks up
 * the remainder. This is what keeps the first run on a 539 MB database from
 * locking the live app behind one enormous DELETE.
 *
 * NO VACUUM. Deleting rows returns pages to SQLite's freelist; it does not
 * shrink the file. VACUUM rewrites the entire database and would block every
 * reader and writer for the duration — unacceptable under the live app. The job
 * reports `freelistPagesAfter` and `dbSizeBytesAfter` so an operator can decide
 * to run VACUUM during a real maintenance window.
 *
 * Timestamp dialect: mission-control.db stores BOTH ISO-'T'-'Z' and SQLite
 * space-separated timestamps in the same TEXT columns, so every comparison goes
 * through `sqlTime()` (src/lib/db/index.ts:282). A naive TEXT compare would sort
 * 'T' after ' ' and silently mis-window. A NULL created_at never matches a
 * comparison, so a row with no timestamp is never deleted.
 *
 * Kill flag:
 *   DISABLE_DB_RETENTION=1|true — skip the job entirely, delete nothing, and
 *   report a skippedReason so wrap() records the tick as 'disabled' rather than
 *   a false-green 'ok'.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, run, sqlTime } from '@/lib/db';

// ── Exported cron config (consumed by scheduler.ts) ─────────────────────────

/** 03:40 every day — after the nightly traffic trough, before the morning board. */
export const DB_RETENTION_CRON_EXPR = '40 3 * * *';
export const DB_RETENTION_CRON_TIMEZONE = 'America/New_York';

// ── Tunables ────────────────────────────────────────────────────────────────

const STAGE_TIMINGS_RETENTION_DAYS_DEFAULT = 30;
const SSE_EVENT_LOG_RETENTION_DAYS_DEFAULT = 14;
const EVENTS_RETENTION_DAYS_DEFAULT = 90;
const TASK_ACTIVITIES_RETENTION_DAYS_DEFAULT = 30;

const BATCH_SIZE_DEFAULT = 5000;
const BUDGET_SECONDS_DEFAULT = 60;

/**
 * Read a positive-integer env override. Anything that is not a finite integer
 * >= 1 (absent, empty, '0', '-5', 'abc', '7.5') falls back to the default, so a
 * typo can never widen a retention rule into deleting everything.
 */
function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

// ── Result shape ────────────────────────────────────────────────────────────

export interface DbRetentionDeleted {
  presentation_stage_timings: number;
  sse_event_log: number;
  events: number;
  task_activities: number;
}

export interface DbRetentionResult {
  /** ISO timestamp the job started. */
  ranAt: string;
  /** Set only on a deliberate skip (kill flag). wrap() reads this and records
   *  the job_liveness tick as 'disabled' instead of 'ok'. */
  skippedReason?: string;
  /** Rows actually deleted, per table. */
  deleted: DbRetentionDeleted;
  /** True when the time budget ran out before every table was fully pruned. */
  budgetExhausted: boolean;
  /** PRAGMA freelist_count after the deletes — pages VACUUM could reclaim. */
  freelistPagesAfter: number;
  /** page_size * page_count after the deletes — the file size on disk. */
  dbSizeBytesAfter: number;
  /** Wall-clock milliseconds the run took. */
  durationMs: number;
}

function emptyDeleted(): DbRetentionDeleted {
  return {
    presentation_stage_timings: 0,
    sse_event_log: 0,
    events: 0,
    task_activities: 0,
  };
}

/**
 * The single log/event line for a completed run. Shared by scheduler.ts (the
 * `[cron] db-retention: ` console line) and the `db_retention_ran` events row so
 * the log and the durable record can never drift apart.
 */
export function formatDbRetentionSummary(result: DbRetentionResult): string {
  const d = result.deleted;
  const seconds = (result.durationMs / 1000).toFixed(1);
  const reclaimableMb = (result.freelistPagesAfter * pageSize()) / (1024 * 1024);
  return (
    `deleted stage_timings=${d.presentation_stage_timings} ` +
    `sse_event_log=${d.sse_event_log} events=${d.events} ` +
    `task_activities=${d.task_activities} in ${seconds}s; ` +
    `${result.freelistPagesAfter} free pages ` +
    `(~${reclaimableMb.toFixed(1)} MB reclaimable by VACUUM)` +
    (result.budgetExhausted ? ' — time budget exhausted, resuming next run' : '')
  );
}

// ── SQLite introspection helpers ────────────────────────────────────────────

function pragmaNumber(pragma: string, field: string): number {
  try {
    const row = queryOne<Record<string, number>>(`PRAGMA ${pragma}`, []);
    const value = row?.[field];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function pageSize(): number {
  return pragmaNumber('page_size', 'page_size');
}

/** A minimal fixture (or a half-migrated box) may not carry every table yet. */
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

// ── The prune loop ──────────────────────────────────────────────────────────

/**
 * Delete rows matching one rule in bounded batches until the rule is exhausted
 * or the time budget runs out.
 *
 * `rowidSelect` must be a SELECT of rowids with exactly two bind parameters, in
 * order: the datetime modifier (e.g. '-30 days') and the batch LIMIT.
 *
 * Returns the number of rows deleted and whether it stopped on the budget.
 */
function pruneInBatches(
  table: string,
  rowidSelect: string,
  days: number,
  batchSize: number,
  deadlineMs: number,
): { deleted: number; budgetExhausted: boolean } {
  if (!tableExists(table)) return { deleted: 0, budgetExhausted: false };

  const sql = `DELETE FROM ${table} WHERE rowid IN (${rowidSelect})`;
  let deleted = 0;

  for (;;) {
    if (Date.now() >= deadlineMs) return { deleted, budgetExhausted: true };
    let changes = 0;
    try {
      changes = run(sql, [`-${days} days`, batchSize]).changes;
    } catch (err) {
      // A prune failure on one table must never abort the others — the job's
      // whole purpose is bounded, best-effort cleanup.
      console.warn(`[db-retention] prune of ${table} failed:`, (err as Error).message);
      return { deleted, budgetExhausted: false };
    }
    deleted += changes;
    if (changes < batchSize) return { deleted, budgetExhausted: false };
  }
}

/**
 * Nightly retention pass. Idempotent: a second run in the same night deletes
 * nothing new because every eligible row is already gone.
 */
export async function runDbRetention(): Promise<DbRetentionResult> {
  const startedMs = Date.now();
  const ranAt = new Date(startedMs).toISOString();

  if (process.env.DISABLE_DB_RETENTION === '1' || process.env.DISABLE_DB_RETENTION === 'true') {
    return {
      ranAt,
      skippedReason: 'DISABLE_DB_RETENTION set',
      deleted: emptyDeleted(),
      budgetExhausted: false,
      freelistPagesAfter: pragmaNumber('freelist_count', 'freelist_count'),
      dbSizeBytesAfter: pageSize() * pragmaNumber('page_count', 'page_count'),
      durationMs: Date.now() - startedMs,
    };
  }

  const batchSize = intEnv('DB_RETENTION_BATCH_SIZE', BATCH_SIZE_DEFAULT);
  const budgetSeconds = intEnv('DB_RETENTION_BUDGET_SECONDS', BUDGET_SECONDS_DEFAULT);
  const deadlineMs = startedMs + budgetSeconds * 1000;

  const deleted = emptyDeleted();
  let budgetExhausted = false;

  // 1. presentation_stage_timings — pure instrumentation, age alone decides.
  {
    const r = pruneInBatches(
      'presentation_stage_timings',
      `SELECT rowid FROM presentation_stage_timings
        WHERE ${sqlTime('created_at')} < datetime('now', ?)
        LIMIT ?`,
      intEnv('STAGE_TIMINGS_RETENTION_DAYS', STAGE_TIMINGS_RETENTION_DAYS_DEFAULT),
      batchSize,
      deadlineMs,
    );
    deleted.presentation_stage_timings = r.deleted;
    budgetExhausted ||= r.budgetExhausted;
  }

  // 2. sse_event_log — live-feed replay buffer, age alone decides.
  if (!budgetExhausted) {
    const r = pruneInBatches(
      'sse_event_log',
      `SELECT rowid FROM sse_event_log
        WHERE ${sqlTime('created_at')} < datetime('now', ?)
        LIMIT ?`,
      intEnv('SSE_EVENT_LOG_RETENTION_DAYS', SSE_EVENT_LOG_RETENTION_DAYS_DEFAULT),
      batchSize,
      deadlineMs,
    );
    deleted.sse_event_log = r.deleted;
    budgetExhausted ||= r.budgetExhausted;
  }

  // 3. events — age AND the owning card must be finished. A row on a live card
  //    (status not 'done' and archived_at IS NULL) is never deleted, at any age.
  //    task_id NULL (board-wide) and orphaned rows are prunable.
  if (!budgetExhausted) {
    const r = pruneInBatches(
      'events',
      `SELECT e.rowid
         FROM events e
         LEFT JOIN tasks t ON t.id = e.task_id
        WHERE ${sqlTime('e.created_at')} < datetime('now', ?)
          AND (
                e.task_id IS NULL
             OR t.id IS NULL
             OR t.status = 'done'
             OR t.archived_at IS NOT NULL
          )
        LIMIT ?`,
      intEnv('EVENTS_RETENTION_DAYS', EVENTS_RETENTION_DAYS_DEFAULT),
      batchSize,
      deadlineMs,
    );
    deleted.events = r.deleted;
    budgetExhausted ||= r.budgetExhausted;
  }

  // 4. task_activities — age AND the owning task must be done, archived, or
  //    gone. A live task keeps its full activity trail (liveness signal).
  if (!budgetExhausted) {
    const r = pruneInBatches(
      'task_activities',
      `SELECT ta.rowid
         FROM task_activities ta
         LEFT JOIN tasks t ON t.id = ta.task_id
        WHERE ${sqlTime('ta.created_at')} < datetime('now', ?)
          AND (
                t.id IS NULL
             OR t.status = 'done'
             OR t.archived_at IS NOT NULL
          )
        LIMIT ?`,
      intEnv('TASK_ACTIVITIES_RETENTION_DAYS', TASK_ACTIVITIES_RETENTION_DAYS_DEFAULT),
      batchSize,
      deadlineMs,
    );
    deleted.task_activities = r.deleted;
    budgetExhausted ||= r.budgetExhausted;
  }

  // Deliberately NOT a VACUUM — see the file header. Report what VACUUM would
  // reclaim and let an operator choose the maintenance window.
  const result: DbRetentionResult = {
    ranAt,
    deleted,
    budgetExhausted,
    freelistPagesAfter: pragmaNumber('freelist_count', 'freelist_count'),
    dbSizeBytesAfter: pageSize() * pragmaNumber('page_count', 'page_count'),
    durationMs: Date.now() - startedMs,
  };

  // Durable record of the run, board-wide (task_id NULL). Best-effort: a failed
  // bookkeeping write must never turn a successful prune into a job error.
  try {
    run('INSERT INTO events(id,type,task_id,message,created_at) VALUES(?,?,NULL,?,?)', [
      uuidv4(),
      'db_retention_ran',
      formatDbRetentionSummary(result),
      new Date().toISOString(),
    ]);
  } catch (err) {
    console.warn('[db-retention] could not record db_retention_ran event:', (err as Error).message);
  }

  return result;
}
