/**
 * FLOOD-01 — stage-timings ingest guard (placeholder run ids + per-run flood
 * breaker).
 *
 * THE INCIDENT THIS PREVENTS (measured on the operator box, 2026-09-16):
 * `presentation_stage_timings` went from ~3,400 rows to 1,481,914 rows between
 * 2026-09-15 12:19 and 2026-09-16 23:27, taking the SQLite database to 875 MB
 * (539 MB table + ~100 MB indexes). A crash-looping presentation runner posted
 * a `phase_exit` event roughly 50 times per second for two days:
 *   - 1,394,621 of those rows carried `run_id = 'run'` — a literal placeholder
 *     string, not a run id,
 *   - every one was event='phase_exit', phase_id='C', status='nonzero_rc_3',
 *     task_id NULL, event_id NULL,
 *   - and because `event_id` was NULL they took the LEGACY insert path in
 *     /api/presentations/stage-timings, which has no dedupe key and no ceiling,
 *     so every single POST landed a new row.
 *
 * Two independent rules close that hole, and they are deliberately independent:
 *
 *   1. isPlaceholderRunId() — a run id that is a placeholder is refused at the
 *      door (400). 'run' is not a run id. This alone would have stopped the
 *      measured incident, but it only catches a runner that is ALSO sloppy
 *      about its identity.
 *   2. checkRunFlood() — a ceiling on how fast (and how much, ever) ONE run may
 *      post. This catches the same loop when the runner sends a perfectly
 *      well-formed unique run id, which the first rule cannot see.
 *
 * FAIL-OPEN ON A BROKEN INSTRUMENT: every DB read here is wrapped. If the
 * table or the `events` table is missing (fresh box that predates migration
 * 127, minimal fixture), the guard reports "not refused" and the ingest route's
 * own self-heal path runs. A false 429 would silently drop real telemetry; a
 * missed breaker check on a box with no timing table costs nothing.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { notifySystem } from '@/lib/notify';

// ───────────────────────────── Placeholder run ids ──────────────────────────

/**
 * Literal strings a runner emits when it has NOT resolved its own run id —
 * an unexpanded shell variable, a stringified null/undefined, a hardcoded
 * default. Compared case-insensitively after trimming.
 */
export const PLACEHOLDER_RUN_IDS: readonly string[] = [
  'run',
  'test',
  'undefined',
  'null',
  'none',
  'default',
];

/** A real run id is at least this long; shorter is never a run identity. */
export const MIN_RUN_ID_LENGTH = 4;

/**
 * True when `runId` is a placeholder rather than a real run identity.
 * Shared by the ingest route and its tests so the rule has exactly one
 * definition.
 */
export function isPlaceholderRunId(runId: unknown): boolean {
  if (typeof runId !== 'string') return true;
  const normalized = runId.trim().toLowerCase();
  if (normalized.length < MIN_RUN_ID_LENGTH) return true;
  return PLACEHOLDER_RUN_IDS.includes(normalized);
}

/** The 400 body the ingest route returns for a placeholder run id. */
export function placeholderRunIdBody(runId: string): { error: string; run_id: string } {
  return {
    error: `run_id "${runId}" is a placeholder, not a run id — the runner must send its real run id`,
    run_id: runId,
  };
}

// ────────────────────────────── Flood breaker ───────────────────────────────

/** Rolling window the per-run rate ceiling is measured over. */
export const FLOOD_WINDOW_MINUTES = 10;

/** One event per second for ten minutes. Far above any healthy deck run. */
export const DEFAULT_MAX_ROWS_PER_10MIN = 600;

/** Absolute lifetime ceiling for a single run id. */
export const DEFAULT_MAX_ROWS_PER_RUN = 20_000;

/** Seconds the runner is told to wait before posting again. */
export const FLOOD_RETRY_AFTER_SECONDS = 600;

/** The `events.type` written once per flooding run per cooldown. */
export const FLOOD_EVENT_TYPE = 'stage_timings_flood_refused';

/** One alert per run id per this many minutes — never a thousand. */
export const FLOOD_ALERT_COOLDOWN_MINUTES = 60;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/** Rows one run may post in a 10-minute window (STAGE_TIMINGS_MAX_ROWS_PER_10MIN). */
export function maxRowsPer10Min(): number {
  return positiveIntEnv('STAGE_TIMINGS_MAX_ROWS_PER_10MIN', DEFAULT_MAX_ROWS_PER_10MIN);
}

/** Rows one run may post in total, ever (STAGE_TIMINGS_MAX_ROWS_PER_RUN). */
export function maxRowsPerRun(): number {
  return positiveIntEnv('STAGE_TIMINGS_MAX_ROWS_PER_RUN', DEFAULT_MAX_ROWS_PER_RUN);
}

export interface FloodRefusal {
  refused: true;
  /** 'window' = rate ceiling over the last 10 minutes; 'lifetime' = total cap. */
  kind: 'window' | 'lifetime';
  run_id: string;
  rows_last_10_min: number;
  rows_total: number;
  limit: number;
  /** The HTTP error string (also the `events.message` text). */
  error: string;
  /** Plain-English operator sentence for Telegram. */
  telegram: string;
}

export type FloodVerdict = { refused: false } | FloodRefusal;

/**
 * SQLite's `datetime('now')` format — 'YYYY-MM-DD HH:MM:SS' in UTC, which is
 * what `presentation_stage_timings.created_at` DEFAULTs to. The cutoff is
 * computed here and bound as a plain parameter so the comparison stays
 * sargable against idx_presentation_stage_timings_run_created (migration 148);
 * wrapping the COLUMN in datetime() instead would force a scan of every row
 * the flooding run already wrote — exactly the 1.4M-row case this guards.
 */
function sqliteTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}

function timingColumns(db: Database.Database): Set<string> {
  try {
    return new Set(
      (db.prepare('PRAGMA table_info(presentation_stage_timings)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
  } catch {
    return new Set<string>();
  }
}

/**
 * Count the rows already stored for `runId`.
 *
 * COMPANY SCOPE: when the company_id column exists (migration 144) and an
 * active company resolves, the count is restricted to that company's rows OR
 * rows with an EMPTY company_id. The empty arm is load-bearing, not laxity:
 * the legacy insert path never stamps company_id, so every one of the
 * 1,394,621 incident rows carries ''. Scoping strictly to the active company
 * would count zero of them and the breaker would never trip on the exact
 * failure it exists for.
 */
function countRowsForRun(
  db: Database.Database,
  runId: string,
  companyId: string,
  sinceIso: string | null,
): number {
  const cols = timingColumns(db);
  if (cols.size === 0) return 0;
  const scoped = cols.has('company_id') && companyId.length > 0;
  const where: string[] = ['run_id = ?'];
  const params: unknown[] = [runId];
  if (sinceIso) {
    where.push('created_at >= ?');
    params.push(sinceIso);
  }
  if (scoped) {
    where.push("(company_id = ? OR company_id = '')");
    params.push(companyId);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM presentation_stage_timings WHERE ${where.join(' AND ')}`,
    )
    .get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Decide whether this run may write more timing rows.
 *
 * Checked in order: the 10-minute rate window first (the live-loop signal),
 * then the lifetime ceiling (a run that looped slowly, or across restarts).
 * Never throws — a broken instrument reports "not refused" (see the fail-open
 * note in the module header).
 */
export function checkRunFlood(
  db: Database.Database,
  runId: string,
  companyId: string,
): FloodVerdict {
  let rowsLast10Min = 0;
  let rowsTotal = 0;
  try {
    const cutoff = sqliteTimestamp(Date.now() - FLOOD_WINDOW_MINUTES * 60_000);
    rowsLast10Min = countRowsForRun(db, runId, companyId, cutoff);
    const windowLimit = maxRowsPer10Min();
    if (rowsLast10Min >= windowLimit) {
      rowsTotal = countRowsForRun(db, runId, companyId, null);
      return {
        refused: true,
        kind: 'window',
        run_id: runId,
        rows_last_10_min: rowsLast10Min,
        rows_total: rowsTotal,
        limit: windowLimit,
        error:
          `stage-timings flood breaker: run ${runId} has posted ${rowsLast10Min} events in the ` +
          `last ${FLOOD_WINDOW_MINUTES} minutes (limit ${windowLimit}); the runner is looping — ` +
          'fix the runner, then resume',
        telegram:
          `Presentation run ${runId} is posting timing events in a loop (${rowsLast10Min} in ` +
          `${FLOOD_WINDOW_MINUTES} minutes). The command center is refusing them so the database ` +
          'does not fill up. The runner needs to be stopped and fixed.',
      };
    }

    rowsTotal = countRowsForRun(db, runId, companyId, null);
    const lifetimeLimit = maxRowsPerRun();
    if (rowsTotal >= lifetimeLimit) {
      return {
        refused: true,
        kind: 'lifetime',
        run_id: runId,
        rows_last_10_min: rowsLast10Min,
        rows_total: rowsTotal,
        limit: lifetimeLimit,
        error:
          `stage-timings flood breaker: run ${runId} has posted ${rowsTotal} events in total and ` +
          `has hit its lifetime ceiling (limit ${lifetimeLimit}); the runner is looping — fix the ` +
          'runner, then resume',
        telegram:
          `Presentation run ${runId} has posted ${rowsTotal} timing events in total and has hit ` +
          'its lifetime ceiling. The command center is refusing them so the database does not ' +
          'fill up. The runner needs to be stopped and fixed.',
      };
    }
  } catch (err) {
    // Missing table / half-migrated box: never block ingest on a broken check.
    console.warn(
      '[STAGE-TIMINGS] flood-breaker count failed (ingest continues):',
      err instanceof Error ? err.message : String(err),
    );
    return { refused: false };
  }

  return { refused: false };
}

/** The HTTP body returned with a 429. */
export function floodRefusalBody(refusal: FloodRefusal): Record<string, unknown> {
  return {
    error: refusal.error,
    run_id: refusal.run_id,
    rows_last_10_min: refusal.rows_last_10_min,
    rows_total: refusal.rows_total,
    limit: refusal.limit,
  };
}

/** LIKE-safe: the run id is matched literally inside the event message. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Has an alert for THIS run already been written inside the cooldown?
 *
 * `events.created_at` is written as an ISO-8601 string by every caller in this
 * repo but DEFAULTs to SQLite's space-separated `datetime('now')`. The two
 * formats do not compare correctly as raw strings ('T' > ' ' would make an
 * OLDER ISO row look newer), so this arm — unlike the hot count above — wraps
 * the column in datetime(). It reads at most one row per refusal, so there is
 * no scan cost to protect.
 */
function alertedRecently(db: Database.Database, runId: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT id FROM events
          WHERE type = ?
            AND message LIKE ? ESCAPE '\\'
            AND datetime(created_at) >= datetime('now', ?)
          LIMIT 1`,
      )
      .get(FLOOD_EVENT_TYPE, `%${escapeLike(runId)}%`, `-${FLOOD_ALERT_COOLDOWN_MINUTES} minutes`) as
      | { id: string }
      | undefined;
    return !!row;
  } catch {
    // No events table (minimal fixture): treat as "not alerted" — the write
    // below is itself wrapped, so nothing throws into the request path.
    return false;
  }
}

/**
 * ONE alert, not a thousand.
 *
 * A looping runner hits the breaker as often as it posts — 50 times a second
 * in the measured incident. Writing an event, a log line and a Telegram notice
 * per refusal would replace a database flood with a notification flood, so all
 * three fire at most once per run id per 60 minutes, gated on the durable
 * `events` row (the only record that survives a process restart).
 *
 * Returns true when this call actually raised the alert.
 */
export function recordFloodRefusal(db: Database.Database, refusal: FloodRefusal): boolean {
  if (alertedRecently(db, refusal.run_id)) return false;

  try {
    db.prepare(
      `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(uuidv4(), FLOOD_EVENT_TYPE, null, null, refusal.error, new Date().toISOString());
  } catch (err) {
    // An un-writable events table must not turn a 429 into a 500.
    console.warn(
      '[STAGE-TIMINGS] could not record flood-refusal event:',
      err instanceof Error ? err.message : String(err),
    );
  }

  console.warn(`[STAGE TIMINGS FLOOD] ${refusal.error}`);

  try {
    notifySystem(`[STAGE TIMINGS FLOOD] ${refusal.telegram}`, {
      agent: 'stage-timings-ingest',
      action: 'escalate',
    });
  } catch {
    /* notify is best-effort and never a reason to fail the refusal */
  }

  return true;
}
