import { NextRequest, NextResponse } from 'next/server';
import { getRescueLastUpdatedAt, getRescueReadDb, isRescueStoreAvailable } from '@/lib/rescue/db';
import { listOpenTickets, listRecentTickets } from '@/lib/rescue/queries';
import { sortOpenTickets } from '@/lib/rescue/severity';
import type { RescueTicket } from '@/lib/rescue/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE = { 'Cache-Control': 'no-store' };

export interface RescueTicketsResponse {
  available: boolean;
  open: RescueTicket[];
  recent: RescueTicket[];
  /** MAX(updated_at) from the table — NEVER file mtime, which WAL does not
   *  advance on commit. Clients use it as the "Updated" caption. */
  lastUpdatedAt: string | null;
}

/**
 * GET /api/rescue/tickets?limit=50
 *
 * `open` = every operationally-open ticket, SLA breaches first, then severity,
 * then oldest first (the work queue order). `recent` = the last N tickets by
 * updated_at regardless of state (the activity feed).
 *
 * ALWAYS 200 with `available: false` when the store is absent — same contract
 * as /api/rescue/summary.
 */
export function GET(req: NextRequest): NextResponse {
  const { searchParams } = new URL(req.url);
  const limitParam = Number(searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(200, Math.floor(limitParam)) : 50;

  const db = getRescueReadDb();
  if (!isRescueStoreAvailable(db) || !db) {
    const empty: RescueTicketsResponse = {
      available: false,
      open: [],
      recent: [],
      lastUpdatedAt: null,
    };
    return NextResponse.json(empty, { headers: NO_STORE });
  }

  try {
    const now = Date.now();
    const payload: RescueTicketsResponse = {
      available: true,
      open: sortOpenTickets(listOpenTickets(db, now)),
      recent: listRecentTickets(db, limit, now),
      lastUpdatedAt: getRescueLastUpdatedAt(db),
    };
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: 'Rescue store unreadable', detail: err instanceof Error ? err.message : String(err) },
      { status: 503, headers: NO_STORE },
    );
  }
}
