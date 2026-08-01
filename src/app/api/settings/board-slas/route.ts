import { NextRequest, NextResponse } from 'next/server';
import { resolveSlaThreshold } from '@/lib/board-slas';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The fleet-wide default "Tasks Due" filter window (days). Kept in lockstep
 * with the `(default)` row rendered by /settings/board-slas (page.tsx) and
 * MissionQueue's own prop default — a single missing config must yield the
 * same 7-day window everywhere.
 */
const DUE_DATE_WINDOW_DEFAULT_DAYS = 7;

/**
 * GET /api/settings/board-slas?department=<slug>
 *
 * MR-44 (fix2) — server-side bridge so the client-rendered board
 * (src/components/MissionQueue.tsx, via the useDueDateWindowDays hook) can
 * read the EFFECTIVE "Tasks Due" filter window for its department. The
 * resolution lives in resolveSlaThreshold (src/lib/board-slas.ts) and reads
 * config/board-slas.json off the filesystem, which a client component cannot
 * do — hence this route.
 *
 * Precedence (per board-slas.ts's contract): an explicit
 * BOARD_DUE_DATE_WINDOW_DAYS env var wins for every department, then the
 * department's board-slas.json override, then the fleet default (7). A
 * missing/absent `department` resolves the global default row. Never throws:
 * resolveSlaThreshold is fail-closed, so a malformed config degrades to the
 * safe default rather than an error.
 */
export async function GET(request: NextRequest) {
  const department = request.nextUrl.searchParams.get('department');
  const dueDateWindowDays = resolveSlaThreshold(
    department,
    'dueDateWindowDays',
    DUE_DATE_WINDOW_DEFAULT_DAYS,
  );
  return NextResponse.json({ dueDateWindowDays });
}
