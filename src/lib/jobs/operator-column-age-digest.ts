/**
 * Operator column-age digest (U102 / master spec C12.3 item 10a).
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
 * The MSG-07 ladder (notify.ts) makes the OPERATOR channel loud for individual
 * events — a stuck-block escalation, a qc_starved card, a stale-backlog digest
 * — but nothing gives the operator a single daily READ of "how old is
 * everything on the board right now, broken down by column and department."
 * board-hygiene.ts's five lane rules each react to ONE pathology past ITS OWN
 * threshold; none of them answers "what does the whole board look like today."
 * The master spec names this explicitly (C12.3 item 10a): "a daily operator
 * column-age digest (one message: counts + oldest card per column per
 * department — batched, never per-task drip)."
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────────
 * Once daily, reads every non-archived task in the nine non-terminal columns
 * (see DIGEST_STATUSES below — 'done' is deliberately excluded: a finished
 * task is not a "stuck in a column" concern, and board-hygiene's own 30-day
 * soft-archive already owns that lane's hygiene), groups by
 * (department, status), and sends ONE notifySystem() message carrying the
 * count and the single oldest card's title + age for every non-empty group.
 * SYSTEM audience only (MOVE-IN-SILENCE) — this is an operator-facing digest,
 * never a client-facing one.
 *
 * MR-42 ARCHIVAL TRANSPARENCY (added post-ship): the digest now additionally
 * queries how many done tasks were soft-archived in the past 7 days (by
 * board-hygiene's rule 4 and the weekly-done-clear Sunday sweep). An archival
 * count above zero adds a section to the digest naming it and naming the
 * escape hatch: `?includeArchived=true` on any board query. This closes the
 * gap where an operator lost visible history without knowing why — the daily
 * read now calls it out explicitly.
 *
 * BATCHING DISCIPLINE: exactly one notifySystem() call per run, no matter how
 * many departments/columns have activity — mirrors board-hygiene's stale-
 * backlog "digestNoRequester" batching (rule 5) and the 2.5 "batched, never a
 * per-task drip" doctrine that governs every operator-lane message in this
 * repo.
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
 * The cron entry (scheduler.ts) fires once daily via node-cron's native
 * America/New_York timezone support. As a belt-and-suspenders against a
 * restart or a double cron tick landing twice inside the same day, a
 * cooldown-guarded `events` marker (OPERATOR_COLUMN_AGE_DIGEST_COOLDOWN_HOURS,
 * default 20h — deliberately just under 24h so a legitimate next-day run is
 * never suppressed) reuses the exact pattern board-hygiene's blend-regression
 * check and sweep-liveness.ts already established for a board-wide,
 * non-task-scoped condition: an `events` row with a NULL task_id.
 *
 * An empty board (zero eligible tasks) sends NOTHING — a "the board is
 * completely empty" message every single morning is noise, not a digest.
 *
 * Configuration knobs:
 *   DISABLE_OPERATOR_COLUMN_AGE_DIGEST=1        — skip the job entirely.
 *   OPERATOR_COLUMN_AGE_DIGEST_COOLDOWN_HOURS    — re-fire guard (default 20).
 */

import { queryAll, queryOne, run, sqlTime, parseDbTime, timeNow } from '@/lib/db';
import { notifySystem } from '@/lib/notify';
import { v4 as uuidv4 } from 'uuid';

// ── Exported cron config (consumed by scheduler.ts) ─────────────────────────

/** Daily at 06:45 in the timezone below — ahead of board-hygiene's hourly
 *  tick and the 07:00 weekly-done-clear window, so the digest always reflects
 *  a board that has not yet been touched by either job that morning. */
export const OPERATOR_COLUMN_AGE_DIGEST_CRON_EXPR = '45 6 * * *';
export const OPERATOR_COLUMN_AGE_DIGEST_CRON_TIMEZONE = 'America/New_York';

const EVT_DIGEST_SENT = 'operator_column_age_digest_sent';

function numEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const DIGEST_COOLDOWN_HOURS = numEnv('OPERATOR_COLUMN_AGE_DIGEST_COOLDOWN_HOURS', 20);

/**
 * The columns this digest tracks, in pipeline order (used for deterministic
 * message ordering). 'done' is intentionally absent — see file header.
 */
export const DIGEST_STATUSES = [
  'backlog',
  'inbox',
  'planning',
  'pending_dispatch',
  'assigned',
  'in_progress',
  'review',
  'testing',
  'blocked',
] as const;

export type DigestStatus = (typeof DIGEST_STATUSES)[number];

const UNASSIGNED_DEPARTMENT_LABEL = '(unassigned)';

// ── Row + result shapes ──────────────────────────────────────────────────────

export interface DigestTaskRow {
  id: string;
  title: string;
  department: string | null;
  status: string;
  last_progress_at: string | null;
  updated_at: string;
}

export interface ColumnAgeEntry {
  department: string;
  status: string;
  count: number;
  oldestTaskId: string;
  oldestTaskTitle: string;
  oldestAgeHours: number;
}

export interface OperatorColumnAgeDigestResult {
  ranAt: string;
  /** Set when the run produced no digest — env opt-out, empty board, or
   *  cooldown-suppressed. Absent when a digest was actually sent. */
  skippedReason?: string;
  totalTasks: number;
  departmentCount: number;
  entries: ColumnAgeEntry[];
  digestSent: boolean;
  /** The exact text sent to notifySystem() (present only when digestSent). */
  message?: string;
  /** MR-42: count of done tasks archived in the past 7 days (rule 4 + Sunday
   *  sweep). Zero means nothing was recently cleaned up. */
  recentlyArchivedCount: number;
}

// ── Pure grouping logic (DB-free — directly unit-testable) ─────────────────

/**
 * Group task rows into one ColumnAgeEntry per (department, status), tracking
 * the count and the SINGLE oldest card (by last_progress_at ?? updated_at —
 * the same "age" convention board-hygiene's blocked-lane rule already uses).
 * Rows whose age cannot be parsed are skipped (never crash the digest on a
 * malformed timestamp).
 */
export function computeColumnAgeEntries(
  rows: DigestTaskRow[],
  now: number = Date.now(),
): ColumnAgeEntry[] {
  const groups = new Map<
    string,
    { department: string; status: string; count: number; oldestId: string; oldestTitle: string; oldestAgeHours: number }
  >();

  for (const row of rows) {
    const department =
      row.department && row.department.trim() ? row.department.trim() : UNASSIGNED_DEPARTMENT_LABEL;
    const progressTs = row.last_progress_at ?? row.updated_at;
    const progressMs = parseDbTime(progressTs);
    if (Number.isNaN(progressMs)) continue;
    const ageHours = (now - progressMs) / (1000 * 60 * 60);

    const key = `${department}\u0000${row.status}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        department,
        status: row.status,
        count: 1,
        oldestId: row.id,
        oldestTitle: row.title,
        oldestAgeHours: ageHours,
      });
    } else {
      existing.count += 1;
      if (ageHours > existing.oldestAgeHours) {
        existing.oldestId = row.id;
        existing.oldestTitle = row.title;
        existing.oldestAgeHours = ageHours;
      }
    }
  }

  const statusRank = new Map<string, number>(DIGEST_STATUSES.map((s, i) => [s, i]));
  const entries: ColumnAgeEntry[] = [];
  // forEach, not for..of: this repo's tsconfig target predates
  // downlevelIteration, so iterating a Map directly does not compile
  // (see notify.ts's pruneDedup() for the same documented constraint).
  groups.forEach((v) => {
    entries.push({
      department: v.department,
      status: v.status,
      count: v.count,
      oldestTaskId: v.oldestId,
      oldestTaskTitle: v.oldestTitle,
      oldestAgeHours: v.oldestAgeHours,
    });
  });

  entries.sort((a, b) => {
    if (a.department !== b.department) return a.department.localeCompare(b.department);
    return (statusRank.get(a.status) ?? DIGEST_STATUSES.length) - (statusRank.get(b.status) ?? DIGEST_STATUSES.length);
  });

  return entries;
}

/** Human-readable age label: hours under 48h, days at/above it. */
function formatAge(ageHours: number): string {
  if (ageHours >= 48) return `${Math.round(ageHours / 24)}d`;
  return `${Math.round(ageHours)}h`;
}

/**
 * Build the ONE batched message notifySystem() sends. Deliberately never
 * emits a per-task line — one line per non-empty (department, status) group,
 * carrying the count and the single oldest card.
 *
 * @param recentlyArchivedCount  MR-42: count of done tasks soft-archived in
 *  the past 7 days. Included in the message so the operator knows tasks were
 *  removed from the visible board — and that ?includeArchived=true still
 *  surfaces them.
 */
export function buildColumnAgeDigestMessage(
  entries: ColumnAgeEntry[],
  totalTasks: number,
  departmentCount: number,
  recentlyArchivedCount: number = 0,
): string {
  const lines: string[] = [
    `[DAILY DIGEST] Column ages — ${departmentCount} department(s), ${totalTasks} active task(s).`,
  ];

  let currentDepartment: string | null = null;
  for (const entry of entries) {
    if (entry.department !== currentDepartment) {
      lines.push('');
      lines.push(`${entry.department}:`);
      currentDepartment = entry.department;
    }
    lines.push(
      `  • ${entry.status}: ${entry.count} (oldest ${formatAge(entry.oldestAgeHours)} — "${entry.oldestTaskTitle}")`,
    );
  }

  // MR-42: archival transparency — operator knows what was cleaned up and how
  // to see it. Only included when count > 0 to avoid noise on an idle board.
  if (recentlyArchivedCount > 0) {
    lines.push('');
    lines.push(
      `[ARCHIVAL] ${recentlyArchivedCount} done task(s) soft-archived this week ` +
      `(rule 4 / Sunday sweep). Use ?includeArchived=true on any board query ` +
      `to browse them — they are hidden, not deleted.`,
    );
  }

  return lines.join('\n');
}

function isDisabled(): boolean {
  return (
    process.env.DISABLE_OPERATOR_COLUMN_AGE_DIGEST === '1' ||
    process.env.DISABLE_OPERATOR_COLUMN_AGE_DIGEST === 'true'
  );
}

function emptyResult(ranAt: string, skippedReason: string): OperatorColumnAgeDigestResult {
  return { ranAt, skippedReason, totalTasks: 0, departmentCount: 0, entries: [], digestSent: false, recentlyArchivedCount: 0 };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Compute and (once per cooldown window) send the daily operator column-age
 * digest. Safe to call directly in tests — no schedule-window guard beyond
 * the cooldown marker described in the file header.
 */
export async function runOperatorColumnAgeDigest(): Promise<OperatorColumnAgeDigestResult> {
  const ranAt = timeNow();

  if (isDisabled()) {
    return emptyResult(ranAt, 'DISABLE_OPERATOR_COLUMN_AGE_DIGEST env is set');
  }

  let rows: DigestTaskRow[];
  try {
    const placeholders = DIGEST_STATUSES.map(() => '?').join(',');
    rows = queryAll<DigestTaskRow>(
      `SELECT id, title, department, status, last_progress_at, updated_at
         FROM tasks
        WHERE archived_at IS NULL
          AND status IN (${placeholders})`,
      [...DIGEST_STATUSES],
    );
  } catch (err) {
    console.warn('[operator-column-age-digest] board query failed:', (err as Error).message);
    return emptyResult(ranAt, `board query failed: ${(err as Error).message}`);
  }

  if (rows.length === 0) {
    return emptyResult(ranAt, 'no active tasks on the board — nothing to digest');
  }

  const entries = computeColumnAgeEntries(rows);
  const totalTasks = rows.length;
  const departmentCount = new Set(entries.map((e) => e.department)).size;

  // MR-42: query recently-archived done tasks (past 7 days) so the operator
  // gets a daily reminder when board-hygiene's rule-4 or the weekly-done-clear
  // Sunday sweep silently removes cards from the visible board.
  let recentlyArchivedCount = 0;
  try {
    recentlyArchivedCount =
      queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tasks
          WHERE status = 'done'
            AND archived_at IS NOT NULL
            AND archived_at >= datetime('now', '-7 days')`,
        [],
      )?.n ?? 0;
  } catch {
    recentlyArchivedCount = 0;
  }

  // Cooldown/day-dedup guard: at most one digest per COOLDOWN window, so a
  // restart or a double cron tick on the same day never sends a second copy.
  let recentDigest = 0;
  try {
    recentDigest =
      queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM events
          WHERE type = ? AND ${sqlTime('created_at')} >= datetime('now', ?)`,
        [EVT_DIGEST_SENT, `-${DIGEST_COOLDOWN_HOURS} hours`],
      )?.n ?? 0;
  } catch {
    recentDigest = 0;
  }

  if (recentDigest > 0) {
    return {
      ranAt,
      skippedReason: `already sent within the last ${DIGEST_COOLDOWN_HOURS}h`,
      totalTasks,
      departmentCount,
      entries,
      digestSent: false,
      recentlyArchivedCount,
    };
  }

  const message = buildColumnAgeDigestMessage(entries, totalTasks, departmentCount, recentlyArchivedCount);
  notifySystem(message, { agent: 'operator-column-age-digest', action: 'daily_digest' });

  try {
    run(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, NULL, ?, ?)`, [
      uuidv4(),
      EVT_DIGEST_SENT,
      message,
      ranAt,
    ]);
  } catch {
    /* cooldown marker is best-effort — the notifySystem() call above already fired */
  }

  return { ranAt, totalTasks, departmentCount, entries, digestSent: true, message, recentlyArchivedCount };
}
