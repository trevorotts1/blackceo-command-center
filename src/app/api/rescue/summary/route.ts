import { NextRequest, NextResponse } from 'next/server';
import { getRescueReadDb, isRescueStoreAvailable } from '@/lib/rescue/db';
import {
  capSuppressedForDay,
  listTicketsForDay,
  listTicketsForWindow,
  mttrForWindow,
  openCountsBySeverity,
  repeatOffenders,
} from '@/lib/rescue/queries';
import { readStandingBlocks } from '@/lib/rescue/standing';
import { easternDayWindow, orderSeverityCounts, tallyDaily, utcDayKey } from '@/lib/rescue/severity';
import type { RescueSummary } from '@/lib/rescue/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE = { 'Cache-Control': 'no-store' };
const DEFAULT_WINDOW_DAYS = 7;

/**
 * GET /api/rescue/summary
 *
 * The Rescue Rangers headline view (P13): open tickets by severity, the five
 * daily counts, standing blocks, and the same rolling-window stats the 18:00
 * digest reports.
 *
 * ALWAYS 200. A box without the durable ticket store (Batch C not deployed
 * here, or any client box) gets `available: false` with zeroed counts — the
 * page renders its empty state, and the gated nav entry stays hidden. A
 * missing data source is not a server error, and a 500 here would make the
 * whole dashboard look broken on every box that legitimately has no receiver.
 */
export function GET(req: NextRequest): NextResponse {
  const { searchParams } = new URL(req.url);
  const dayParam = searchParams.get('day');
  const windowParam = Number(searchParams.get('window'));
  const windowDays =
    Number.isFinite(windowParam) && windowParam > 0 && windowParam <= 90
      ? Math.floor(windowParam)
      : DEFAULT_WINDOW_DAYS;

  const now = Date.now();
  // The headline day is the Eastern day; the cap line is the store's UTC day.
  const requestedDay = /^\d{4}-\d{2}-\d{2}$/.test(dayParam ?? '') ? (dayParam as string) : null;
  const win = easternDayWindow(new Date(now));
  const dayLabel = requestedDay ?? win.label;
  const capDay = requestedDay ?? utcDayKey(new Date(now));

  const standing = readStandingBlocks();
  const db = getRescueReadDb();

  if (!isRescueStoreAvailable(db) || !db) {
    const empty: RescueSummary = {
      available: false,
      generatedAt: new Date(now).toISOString(),
      openBySeverity: orderSeverityCounts([]),
      openTotal: 0,
      daily: tallyDaily(dayLabel, []),
      standing,
      windowDays,
      mttrMinutes: null,
      resolvedInWindow: 0,
      repeatOffenders: [],
      capSuppressedToday: [],
    };
    return NextResponse.json(empty, { headers: NO_STORE });
  }

  try {
    const openBySeverity = orderSeverityCounts(openCountsBySeverity(db));
    const openTotal = openBySeverity.reduce((sum, row) => sum + row.open, 0);
    const dailyTickets = requestedDay
      ? listTicketsForDay(db, requestedDay, now)
      : listTicketsForWindow(db, win.startIso, win.endIso, now);
    const daily = tallyDaily(dayLabel, dailyTickets);
    const { mttrMinutes, resolvedInWindow } = mttrForWindow(db, windowDays, now);

    const payload: RescueSummary = {
      available: true,
      generatedAt: new Date(now).toISOString(),
      openBySeverity,
      openTotal,
      daily,
      standing,
      windowDays,
      mttrMinutes,
      resolvedInWindow,
      repeatOffenders: repeatOffenders(db, windowDays, 3, now),
      capSuppressedToday: capSuppressedForDay(db, capDay),
    };
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (err) {
    // A store that exists but cannot be read (locked, truncated, schema drift)
    // IS an error worth surfacing — but not one worth 500-ing the page over.
    return NextResponse.json(
      { error: 'Rescue store unreadable', detail: err instanceof Error ? err.message : String(err) },
      { status: 503, headers: NO_STORE },
    );
  }
}
