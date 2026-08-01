import { NextRequest, NextResponse } from 'next/server';
import { getRescueReadDb, isRescueStoreAvailable } from '@/lib/rescue/db';
import { getTicket, listTicketEvents } from '@/lib/rescue/queries';
import type { RescueEvent, RescueTicket } from '@/lib/rescue/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE = { 'Cache-Control': 'no-store' };

export interface RescueTicketDetailResponse {
  ticket: RescueTicket;
  /** The durable audit trail from `ticket_events`, oldest first. */
  events: RescueEvent[];
}

/**
 * GET /api/rescue/tickets/[ticketId]
 *
 * One ticket plus its full audit timeline. Fetched on demand when a row is
 * expanded, so the list endpoint stays cheap no matter how long a ticket's
 * history grows.
 *
 * 404 when the store has no such ticket — unlike the list endpoints, a
 * SPECIFIC ticket that does not exist is a genuine not-found, not an empty
 * state. A box with no store at all also 404s (there is nothing to show).
 */
export function GET(
  _req: NextRequest,
  { params }: { params: { ticketId: string } },
): NextResponse {
  const ticketId = decodeURIComponent(params.ticketId || '');
  if (!ticketId) {
    return NextResponse.json({ error: 'ticketId required' }, { status: 400, headers: NO_STORE });
  }

  const db = getRescueReadDb();
  if (!isRescueStoreAvailable(db) || !db) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404, headers: NO_STORE });
  }

  try {
    const ticket = getTicket(db, ticketId);
    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404, headers: NO_STORE });
    }
    const payload: RescueTicketDetailResponse = {
      ticket,
      events: listTicketEvents(db, ticketId),
    };
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: 'Rescue store unreadable', detail: err instanceof Error ? err.message : String(err) },
      { status: 503, headers: NO_STORE },
    );
  }
}
