/**
 * PBB-129 / T-34 — the FAILURE adapter over the Command Center's own tables.
 *
 * `bug_tickets` + `bug_ticket_events` are the repo's real P0–P3 exception
 * store (`BugSeverity` is literally 'P0 run-dead' … 'P3 improvement'):
 *   - severity                → P0–P3 (unrecognised → UNKNOWN, never a default)
 *   - assigned_healer_agent_id → the one owner
 *   - dedup_of / recurrence_count → coalescing
 *   - status + closed_at + the closing EVENT actor + a healing report
 *                             → proven clearance (all four parts required)
 *   - count of audit events   → the monotonic revision the stale-command guard
 *                               binds to (events are append-only)
 *
 * TENANCY: the query is ALWAYS filtered by `client_slug`. A missing tenant is
 * UNKNOWN (`tenant_required`) — never "show every client's faults".
 *
 * FAIL-CLOSED: an unreadable ticket table, an unreadable event table or a
 * missing tenant all return a named UNKNOWN. Nothing here ever throws at a
 * route, and an empty tenant result is a PROVEN zero (live), not unknown.
 *
 * Server-only: imports better-sqlite3 through '@/lib/db'.
 */

import { queryAll } from '@/lib/db';
import { parseTime, type AlertInput, type SurfaceResult } from './exceptions-outcomes';

export const FAILURE_ADAPTER_NAME = 'bug_tickets';

export interface BugTicketViewRow {
  id: string;
  symptom: string | null;
  severity: string | null;
  client_slug: string | null;
  status: string | null;
  assigned_healer_agent_id: string | null;
  dedup_of: string | null;
  recurrence_count: number | null;
  evidence_paths: string | null;
  healing_report_path: string | null;
  fix_summary: string | null;
  closed_at: string | null;
  reported_at: string | null;
  updated_at: string | null;
}

export interface BugTicketEventRow {
  bug_id: string;
  to_status: string | null;
  actor: string | null;
  reason: string | null;
  created_at: string | null;
}

export const BUG_TICKET_VIEW_COLUMNS = [
  'id',
  'symptom',
  'severity',
  'client_slug',
  'status',
  'assigned_healer_agent_id',
  'dedup_of',
  'recurrence_count',
  'evidence_paths',
  'healing_report_path',
  'fix_summary',
  'closed_at',
  'reported_at',
  'updated_at',
].join(', ');

export const BUG_EVENT_VIEW_COLUMNS = 'bug_id, to_status, actor, reason, created_at';

type QueryAll = <T>(sql: string, params?: unknown[]) => T[];

const ID_CHUNK = 400;

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;
  return trimmed;
}

/**
 * The event that actually closed the ticket: the LATEST closing event by real
 * TIME, not by raw string.
 *
 * `created_at` is written by two hands. `src/lib/bug-lifecycle.ts` and
 * `src/app/api/bugs/route.ts` pass `new Date().toISOString()`, while a row left
 * to the table DEFAULT gets sqlite `datetime('now')` ('YYYY-MM-DD HH:MM:SS').
 * Compared as text, '2026-10-24T08:00:00Z' sorts ABOVE '2026-10-24 09:00:00'
 * because 'T' sorts past ' ', so an hour-earlier close would be credited with
 * the clearance. Parse both forms and order by the instant.
 */
function lastClosingEvent(
  events: readonly BugTicketEventRow[],
): BugTicketEventRow | null {
  let best: BugTicketEventRow | null = null;
  for (const event of events) {
    if (event.to_status !== 'CLOSED') continue;
    // Strictly greater, never `>=`: a tie must be settled by the total order
    // below, not by which row the query happened to return first.
    if (!best || compareClosingEvents(event, best) > 0) best = event;
  }
  return best;
}

/**
 * TOTAL order over closing events, independent of row order.
 *
 *   1. a proven instant outranks an unproven one;
 *   2. a later instant outranks an earlier one;
 *   3. equal instants (or two unproven times) compare by raw timestamp text;
 *   4. then by actor, then by reason.
 *
 * Steps 3–4 exist because two closes CAN share an instant: the same millisecond
 * with different actors, or the same instant written by both hands
 * ('2026-10-24T08:00:00Z' and '2026-10-24 08:00:00'). Without them the first
 * row wins and the credited actor flips with the query's order. Every record is
 * fully compared here: two distinct events never compare equal, so the pick is
 * the maximum of a set — the same element whatever order the set arrives in.
 */
function compareClosingEvents(
  a: BugTicketEventRow,
  b: BugTicketEventRow,
): number {
  const at = parseTime(cleanText(a.created_at));
  const bt = parseTime(cleanText(b.created_at));
  if (at !== null && bt === null) return 1;
  if (at === null && bt !== null) return -1;
  if (at !== null && bt !== null && at !== bt) return at < bt ? -1 : 1;

  const rawA = cleanText(a.created_at) ?? '';
  const rawB = cleanText(b.created_at) ?? '';
  if (rawA !== rawB) return rawA < rawB ? -1 : 1;

  const actorA = cleanText(a.actor) ?? '';
  const actorB = cleanText(b.actor) ?? '';
  if (actorA !== actorB) return actorA < actorB ? -1 : 1;

  const reasonA = cleanText(a.reason) ?? '';
  const reasonB = cleanText(b.reason) ?? '';
  if (reasonA !== reasonB) return reasonA < reasonB ? -1 : 1;
  return 0;
}

/**
 * Map real `bug_tickets` rows (+ their audit events) to the view's alert
 * records. Pure — the caller owns the read, so this is unit-testable without
 * a database and the route keeps one query policy.
 */
export function bugTicketsToAlerts(
  tickets: readonly BugTicketViewRow[],
  events: readonly BugTicketEventRow[],
): AlertInput[] {
  const eventsByBug = new Map<string, BugTicketEventRow[]>();
  for (const event of events) {
    if (!event?.bug_id) continue;
    const bucket = eventsByBug.get(event.bug_id);
    if (bucket) bucket.push(event);
    else eventsByBug.set(event.bug_id, [event]);
  }

  return tickets.map((ticket) => {
    const ticketEvents = eventsByBug.get(ticket.id) ?? [];
    const closing = lastClosingEvent(ticketEvents);
    const status = cleanText(ticket.status);
    const isClosed = status === 'CLOSED';
    const closedAt = cleanText(ticket.closed_at);
    const evidence =
      cleanText(ticket.healing_report_path) ??
      cleanText(ticket.fix_summary) ??
      cleanText(ticket.evidence_paths);

    return {
      id: ticket.id,
      surface: 'failures',
      severity: cleanText(ticket.severity) ?? '',
      title: cleanText(ticket.symptom) ?? `Bug ${ticket.id}`,
      owner: { assigned_agent_id: ticket.assigned_healer_agent_id ?? null },
      dedup_of: cleanText(ticket.dedup_of),
      first_seen_at: cleanText(ticket.reported_at) ?? cleanText(ticket.updated_at),
      last_seen_at: cleanText(ticket.updated_at) ?? cleanText(ticket.reported_at),
      // A closed ticket with a missing actor or evidence is NOT cleared; the
      // partial clearance record carries exactly which proof is absent.
      revision: ticketEvents.length,
      clearance: isClosed
        ? {
            at: closedAt,
            by: cleanText(closing?.actor),
            evidence,
          }
        : null,
      next_action: null,
    };
  });
}

function failureUnknown(reason: string): SurfaceResult<AlertInput> {
  return { state: 'unknown', reason, adapter: FAILURE_ADAPTER_NAME, items: [] };
}

/**
 * Read one TENANT's failures. `clientSlug` is required: without it the answer
 * is UNKNOWN (`tenant_required`), because a cross-tenant dump is never a
 * client view.
 */
export function loadFailureAlerts(
  clientSlug: string | null | undefined,
  query: QueryAll = queryAll,
): SurfaceResult<AlertInput> {
  const slug = cleanText(clientSlug);
  if (!slug) return failureUnknown('tenant_required');

  let tickets: BugTicketViewRow[];
  try {
    tickets = query<BugTicketViewRow>(
      `SELECT ${BUG_TICKET_VIEW_COLUMNS}
         FROM bug_tickets
        WHERE client_slug = ?
        ORDER BY id`,
      [slug],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failureUnknown(`failure_adapter_failed:${message}`);
  }

  if (tickets.length === 0) {
    // A working, tenant-scoped read that matched nothing is a proven zero.
    return { state: 'live', reason: null, adapter: FAILURE_ADAPTER_NAME, items: [] };
  }

  const events: BugTicketEventRow[] = [];
  const ids = tickets.map((ticket) => ticket.id);
  try {
    for (let index = 0; index < ids.length; index += ID_CHUNK) {
      const chunk = ids.slice(index, index + ID_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      events.push(
        ...query<BugTicketEventRow>(
          `SELECT ${BUG_EVENT_VIEW_COLUMNS}
             FROM bug_ticket_events
            WHERE bug_id IN (${placeholders})
            ORDER BY created_at, id`,
          chunk,
        ),
      );
    }
  } catch (error) {
    // Without the audit trail we cannot prove a revision (stale-command guard)
    // or a closing actor (clearance). Report UNKNOWN; never render the tickets
    // as if they were fully evidenced.
    const message = error instanceof Error ? error.message : String(error);
    return failureUnknown(`failure_events_unreadable:${message}`);
  }

  return {
    state: 'live',
    reason: null,
    adapter: FAILURE_ADAPTER_NAME,
    items: bugTicketsToAlerts(tickets, events),
  };
}

