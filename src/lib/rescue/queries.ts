/**
 * Rescue Rangers ticket dashboard (P13): read queries.
 *
 * Every query runs on the read-only handle from `./db`. No query here can
 * mutate anything: the connection is opened { readonly: true } and
 * better-sqlite3 throws on any write attempt at the SQLite layer.
 *
 * The aggregate shapes intentionally mirror `rescue-report.mjs --json`
 * (open-by-severity, MTTR over a trailing window, repeat offenders, cap
 * suppression) so the page and the 18:00 digest can never tell two different
 * stories about the same day. Where the report stops, this file continues:
 * per-ticket rows and their audit timelines, which the digest never carried.
 */

import type Database from 'better-sqlite3';
import type { RescueEvent, RescueEventRow, RescueTicket, RescueTicketRow } from './types';
import { OPEN_STATUSES, isSlaBreached, normalizeSeverity } from './severity';

const MAX_TICKETS = 200;
const MAX_EVENTS = 500;

/** Named-parameter placeholder list for the open-status set. */
const OPEN_PLACEHOLDERS = OPEN_STATUSES.map((_, i) => `@o${i}`).join(', ');
const OPEN_PARAMS: Record<string, string> = Object.fromEntries(
  OPEN_STATUSES.map((s, i) => [`o${i}`, s]),
);

export function toTicket(row: RescueTicketRow, now: number = Date.now()): RescueTicket {
  return {
    ticketId: row.ticket_id,
    rr: row.rr_number != null ? `RR-${String(row.rr_number).padStart(6, '0')}` : null,
    client: row.client,
    box: row.box,
    agent: row.agent,
    person: row.person,
    failureClass: row.failure_class,
    severity: normalizeSeverity(row.severity),
    status: row.status,
    decisionMode: row.decision_mode,
    source: row.source,
    problem: row.problem,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    slaDueAt: row.sla_due_at,
    slaBreached: isSlaBreached({ status: row.status, sla_due_at: row.sla_due_at }, now),
  };
}

export function toEvent(row: RescueEventRow): RescueEvent {
  return {
    seq: row.seq,
    at: row.at,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actor: row.actor,
    decisionMode: row.decision_mode,
    note: row.note,
  };
}

/** Open-ticket counts grouped by severity (raw; ordering is the caller's). */
export function openCountsBySeverity(
  db: Database.Database,
): Array<{ severity: string | null; open: number }> {
  const rows = db
    .prepare(
      `SELECT severity, COUNT(*) AS open FROM tickets
        WHERE status IN (${OPEN_PLACEHOLDERS})
        GROUP BY severity`,
    )
    .all(OPEN_PARAMS) as Array<{ severity: string | null; open: number }>;
  return rows.map((r) => ({ severity: r.severity, open: Number(r.open) || 0 }));
}

/** Every operationally-open ticket, newest first (capped). */
export function listOpenTickets(db: Database.Database, now: number = Date.now()): RescueTicket[] {
  const rows = db
    .prepare(
      `SELECT * FROM tickets
        WHERE status IN (${OPEN_PLACEHOLDERS})
        ORDER BY created_at DESC
        LIMIT ${MAX_TICKETS}`,
    )
    .all(OPEN_PARAMS) as RescueTicketRow[];
  return rows.map((r) => toTicket(r, now));
}

/**
 * Tickets created on a UTC day (YYYY-MM-DD). The store stamps `created_at` as
 * an ISO-8601 UTC instant and keys its own per-client counters off the same
 * 10-character prefix, so a prefix comparison is the join that matches it.
 */
export function listTicketsForDay(
  db: Database.Database,
  day: string,
  now: number = Date.now(),
): RescueTicket[] {
  const rows = db
    .prepare(
      `SELECT * FROM tickets
        WHERE substr(created_at, 1, 10) = @day
        ORDER BY created_at DESC
        LIMIT ${MAX_TICKETS}`,
    )
    .all({ day }) as RescueTicketRow[];
  return rows.map((r) => toTicket(r, now));
}

/** Most recently touched tickets regardless of state (the activity list). */
export function listRecentTickets(
  db: Database.Database,
  limit = 50,
  now: number = Date.now(),
): RescueTicket[] {
  const n = Math.max(1, Math.min(MAX_TICKETS, Math.floor(limit)));
  const rows = db
    .prepare(`SELECT * FROM tickets ORDER BY updated_at DESC LIMIT ${n}`)
    .all() as RescueTicketRow[];
  return rows.map((r) => toTicket(r, now));
}

export function getTicket(
  db: Database.Database,
  ticketId: string,
  now: number = Date.now(),
): RescueTicket | null {
  const row = db.prepare('SELECT * FROM tickets WHERE ticket_id = @id').get({ id: ticketId }) as
    | RescueTicketRow
    | undefined;
  return row ? toTicket(row, now) : null;
}

/** The durable audit trail for one ticket, oldest event first. */
export function listTicketEvents(db: Database.Database, ticketId: string): RescueEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM ticket_events WHERE ticket_id = @id
        ORDER BY seq ASC LIMIT ${MAX_EVENTS}`,
    )
    .all({ id: ticketId }) as RescueEventRow[];
  return rows.map(toEvent);
}

/** MTTR + resolved volume over a trailing window (mirrors rescue-report.mjs). */
export function mttrForWindow(
  db: Database.Database,
  windowDays: number,
  now: number = Date.now(),
): { mttrMinutes: number | null; resolvedInWindow: number } {
  const cut = new Date(now - windowDays * 86_400_000).toISOString();
  const row = db
    .prepare(
      `SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24 * 60) AS mttr_min,
              COUNT(*) AS resolved_count
         FROM tickets
        WHERE resolved_at IS NOT NULL AND resolved_at >= @cut`,
    )
    .get({ cut }) as { mttr_min: number | null; resolved_count: number } | undefined;
  return {
    mttrMinutes: row && row.mttr_min != null ? Math.round(row.mttr_min * 10) / 10 : null,
    resolvedInWindow: row ? Number(row.resolved_count) || 0 : 0,
  };
}

/** Clients with >= threshold tickets in the window, busiest first. */
export function repeatOffenders(
  db: Database.Database,
  windowDays: number,
  threshold = 3,
  now: number = Date.now(),
): Array<{ client: string | null; tickets: number }> {
  const cut = new Date(now - windowDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT client, COUNT(*) AS tickets FROM tickets
        WHERE created_at >= @cut
        GROUP BY client HAVING COUNT(*) >= @thr
        ORDER BY tickets DESC LIMIT 25`,
    )
    .all({ cut, thr: threshold }) as Array<{ client: string | null; tickets: number }>;
  return rows.map((r) => ({ client: r.client, tickets: Number(r.tickets) || 0 }));
}

/**
 * What the daily cap SWALLOWED today. FIX-RESCUE-13 made the cap go quiet
 * past its limit; this is the surface where that suppressed volume must still
 * be visible, or "post once then go quiet" turns into amnesia.
 */
export function capSuppressedForDay(
  db: Database.Database,
  day: string,
): Array<{ client: string; suppressed: number; lastAt: string }> {
  const rows = db
    .prepare('SELECT day_key, count, last_at FROM cap_suppressions WHERE day_key LIKE @d ORDER BY count DESC')
    .all({ d: `%|${day}` }) as Array<{ day_key: string; count: number; last_at: string }>;
  return rows.map((r) => ({
    client: String(r.day_key).split('|')[0],
    suppressed: Number(r.count) || 0,
    lastAt: r.last_at,
  }));
}
