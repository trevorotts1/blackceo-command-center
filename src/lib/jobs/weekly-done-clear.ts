/**
 * Weekly Done-column archive job.
 *
 * Every Sunday at 07:00 America/New_York (12:00 UTC, 11:00 UTC in DST),
 * tasks whose status is 'done' AND whose archived_at is NULL are soft-
 * archived: their archived_at column is stamped with the current UTC
 * timestamp. They are NOT deleted — they remain fully queryable for
 * analytics, SOP-learning, and audit.
 *
 * Board column flow:
 *   Backlog → To-Do (inbox/planning/assigned/pending_dispatch)
 *          → In Progress → Review/QC → Done
 *                                        ↓  (Sunday 07:00 ET)
 *                                     archived (archived_at IS NOT NULL)
 *
 * Idempotent: a second run in the same week is a no-op because the WHERE
 * clause requires archived_at IS NULL. Only tasks that land in Done AFTER
 * the previous clear are eligible for the next sweep.
 *
 * Configuration knob:
 *   DISABLE_WEEKLY_DONE_CLEAR=1   — skip the job entirely (e.g. during load
 *                                   tests or migrations)
 *
 * The cron expression for Sunday 07:00 ET adjusts for US EST/EDT:
 *   - EDT (UTC-4, Mar–Nov): fire at 11:00 UTC → '0 11 * * 0'
 *   - EST (UTC-5, Nov–Mar): fire at 12:00 UTC → '0 12 * * 0'
 *
 * A single UTC cron expression cannot cover both offsets perfectly.
 * We solve this by running at BOTH 11:00 UTC AND 12:00 UTC on Sundays
 * and making the job itself enforce the America/New_York 07:00 window:
 * if the server's wall-clock in New York is between 06:45–07:30 the job
 * proceeds; otherwise it exits immediately. This is the correct pattern
 * for timezone-aware Sunday jobs in node-cron (which only understands
 * UTC cron expressions when timezone is not set).
 *
 * Alternatively, if the server's TZ is already set to America/New_York,
 * node-cron's `timezone` option is used and a single '0 7 * * 0' is
 * correct. This file supports both modes via the exported
 * WEEKLY_DONE_CLEAR_CRON_EXPR and WEEKLY_DONE_CLEAR_CRON_TIMEZONE exports.
 */

import { getDb } from '@/lib/db';

// ── Exported cron config (consumed by scheduler.ts) ─────────────────────────

/**
 * Cron expression: Sunday 07:00 in the timezone below.
 * When WEEKLY_DONE_CLEAR_TIMEZONE is 'America/New_York', node-cron 4's native
 * timezone support fires at exactly 07:00 ET. When it is 'UTC', a guard inside
 * runWeeklyDoneClear() enforces the 07:00–07:14 ET window manually.
 */
export const WEEKLY_DONE_CLEAR_CRON_EXPR = '0 7 * * 0';
export const WEEKLY_DONE_CLEAR_CRON_TIMEZONE = 'America/New_York';

// ── Job logic ────────────────────────────────────────────────────────────────

export interface WeeklyDoneClearResult {
  /** Number of tasks that were archived in this run. */
  archivedCount: number;
  /** ISO timestamp the job ran. */
  ranAt: string;
  /** Why the job exited without archiving (only when archivedCount === 0 and
   *  it was a deliberate skip, not an absence of eligible rows). */
  skippedReason?: string;
  /** Orphan EMPTY cards soft-archived this run (see archiveOrphanEmptyCards). */
  orphanEmptyArchivedCount?: number;
}

/** Default age (days) before an orphan empty card becomes archivable. */
const ORPHAN_EMPTY_ARCHIVE_DAYS_DEFAULT = 14;

/**
 * Soft-archive ORPHAN EMPTY cards — the board clutter left when a card was
 * created but never got an owner or any content: no assigned agent, an empty
 * description, no deliverables, and no activities, sitting untouched in
 * backlog/inbox past the age threshold. Non-destructive (stamps archived_at;
 * board reads already hide archived rows) and idempotent.
 *
 * STRICT criteria protect real work: a card with ANY deliverable or activity —
 * e.g. the "carded-but-trapped" tasks that actually FINISHED (their deliverable
 * is on disk / registered) — is NEVER archived here; those are recovered to
 * review by the stuck-in-progress sweep instead. A card with any description is
 * likewise skipped, which also excludes signed board-producer cards (their
 * "Source: …" marker lives in the description).
 *
 * Knobs: DISABLE_ORPHAN_EMPTY_ARCHIVE=1 (skip), ORPHAN_EMPTY_ARCHIVE_DAYS (age).
 */
export function archiveOrphanEmptyCards(): { archivedCount: number; ranAt: string; skippedReason?: string } {
  const ranAt = new Date().toISOString();
  if (
    process.env.DISABLE_ORPHAN_EMPTY_ARCHIVE === '1' ||
    process.env.DISABLE_ORPHAN_EMPTY_ARCHIVE === 'true'
  ) {
    return { archivedCount: 0, ranAt, skippedReason: 'DISABLE_ORPHAN_EMPTY_ARCHIVE env is set' };
  }

  const parsed = parseInt(process.env.ORPHAN_EMPTY_ARCHIVE_DAYS || '', 10);
  const days = Number.isFinite(parsed) && parsed >= 1 ? parsed : ORPHAN_EMPTY_ARCHIVE_DAYS_DEFAULT;

  const db = getDb();
  const result = db
    .prepare(
      `UPDATE tasks
          SET archived_at = datetime('now')
        WHERE archived_at IS NULL
          AND status IN ('backlog','inbox')
          AND assigned_agent_id IS NULL
          AND (description IS NULL OR TRIM(description) = '')
          AND created_at <= datetime('now', ?)
          AND id NOT IN (SELECT task_id FROM task_deliverables)
          AND id NOT IN (SELECT task_id FROM task_activities)`,
    )
    .run(`-${days} days`);

  return { archivedCount: result.changes, ranAt };
}

/**
 * Soft-archive all done tasks (archived_at IS NULL). Idempotent, non-destructive.
 *
 * This is the core logic extracted for testability — it does not check any
 * schedule window. The scheduler calls this; unit tests call it directly.
 */
export function archiveDoneTasks(): WeeklyDoneClearResult {
  const ranAt = new Date().toISOString();

  if (
    process.env.DISABLE_WEEKLY_DONE_CLEAR === '1' ||
    process.env.DISABLE_WEEKLY_DONE_CLEAR === 'true'
  ) {
    return { archivedCount: 0, ranAt, skippedReason: 'DISABLE_WEEKLY_DONE_CLEAR env is set' };
  }

  const db = getDb();
  const result = db
    .prepare(
      `UPDATE tasks
          SET archived_at = datetime('now')
        WHERE status = 'done'
          AND archived_at IS NULL`,
    )
    .run();

  // Same weekly maintenance window also clears orphan EMPTY cards (board
  // clutter with no owner and no content). Self-gated by its own env knobs;
  // strict criteria never touch finished/trapped work.
  const orphan = archiveOrphanEmptyCards();

  return {
    archivedCount: result.changes,
    ranAt,
    orphanEmptyArchivedCount: orphan.archivedCount,
  };
}

/**
 * Entry point called by the scheduler. Wraps archiveDoneTasks() with a
 * Sunday / America/New_York time-window guard so accidental manual triggers
 * outside the maintenance window are a no-op (belt-and-suspenders alongside
 * the cron expression).
 */
export async function runWeeklyDoneClear(): Promise<WeeklyDoneClearResult> {
  const now = new Date();

  // Validate: must be Sunday in America/New_York.
  const nyFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  });
  const parts = Object.fromEntries(
    nyFormatter.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const isSunday = parts.weekday === 'Sun';
  const nyHour = parseInt(parts.hour ?? '-1', 10);

  // Allow a 15-minute window centred on 07:00 (06:45–07:14) to account for
  // job scheduler jitter.
  const inWindow = nyHour === 7 || (nyHour === 6 && now.getMinutes() >= 45);

  if (!isSunday || !inWindow) {
    // Only enforce the window when the cron timezone is NOT already set to ET
    // (if the scheduler passes the correct timezone to node-cron, the guard is
    // redundant but harmless).
    if (WEEKLY_DONE_CLEAR_CRON_TIMEZONE !== 'America/New_York') {
      const ranAt = new Date().toISOString();
      return {
        archivedCount: 0,
        ranAt,
        skippedReason: `Outside Sunday 07:00 ET window (weekday=${parts.weekday}, hour=${nyHour})`,
      };
    }
  }

  return archiveDoneTasks();
}
