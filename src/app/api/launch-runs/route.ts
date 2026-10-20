import { NextRequest, NextResponse } from 'next/server';
import { getLaunchRun, listLaunchRuns } from '@/lib/launch-runs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/launch-runs: launch automation runs, read side.
 *
 * Serves the launch plan + progress files on disk. Read-only: no ingest, no
 * writes, no sends, no account calls.
 *
 * GET /api/launch-runs                  → newest-first list with percentage
 * GET /api/launch-runs?launch_id=<id>   → one run (units, states, percentage)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const launchId = searchParams.get('launch_id');

  if (launchId) {
    const run = getLaunchRun(launchId);
    if (!run) {
      return NextResponse.json({ error: 'launch run not found' }, { status: 404 });
    }
    return NextResponse.json(run);
  }

  const { dir, runs, errors } = listLaunchRuns();
  return NextResponse.json({
    runs: runs.map((run) => ({
      launch_id: run.launchId,
      offer_name: run.offerName,
      percentage: run.percentage,
      done_units: run.doneUnits,
      total_units: run.totalUnits,
      counts: run.counts,
      conversation_ai: run.conversationAi,
      calendar: run.calendar,
    })),
    total: runs.length,
    dir,
    errors,
  });
}
