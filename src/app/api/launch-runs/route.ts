import { NextRequest, NextResponse } from 'next/server';
import { getLaunchRun, listLaunchRuns, NOT_INCLUDED_LABEL } from '@/lib/launch-runs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/launch-runs: the DISK view of launch automation runs, read side.
 *
 * Serves the approved plan + producer progress files. Read-only: no ingest, no
 * writes, no sends, no account calls.
 *
 * GET /api/launch-runs                  → newest-first list with percentage
 * GET /api/launch-runs?launch_id=<id>   → one run (units, states, percentage)
 *
 * Honesty contract:
 *   - an unreadable plans directory answers 503 `launch_store_unavailable`,
 *     never `runs: []` (which would read as "no launches");
 *   - a quarantined run returns `availability: "quarantined"`, zero completion
 *     and the actionable `issues` that stopped it;
 *   - a plan section that does not exist returns the neutral
 *     `not_included_label` ("Not included"), never 0/0 as if it were planned.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const launchId = searchParams.get('launch_id');

  if (launchId) {
    const result = listLaunchRuns();
    if (result.availability === 'unavailable') {
      return NextResponse.json(
        {
          error: 'launch_store_unavailable',
          detail: result.errors,
          availability: result.availability,
        },
        { status: 503 },
      );
    }
    const run = result.runs.find((entry) => entry.launchId === launchId);
    if (!run) {
      return NextResponse.json(
        { error: 'launch run not found', availability: result.availability, status: result.status },
        { status: 404 },
      );
    }
    return NextResponse.json(run);
  }

  const { dir, runs, errors, availability, status, issues, quarantined } = listLaunchRuns();
  if (availability === 'unavailable') {
    return NextResponse.json(
      {
        error: 'launch_store_unavailable',
        detail: errors,
        availability,
        status,
        dir,
      },
      { status: 503 },
    );
  }
  return NextResponse.json({
    runs: runs.map((run) => ({
      launch_id: run.launchId,
      offer_name: run.offerName,
      percentage: run.percentage,
      done_units: run.doneUnits,
      total_units: run.totalUnits,
      unknown_units: run.unknownUnits,
      sequence_count: run.sequenceCount,
      message_count: run.messageCount,
      last_updated: run.lastUpdated,
      availability: run.availability,
      issues: run.issues,
      not_included: run.notIncluded,
      not_included_label: NOT_INCLUDED_LABEL,
      plan_hash: run.planHash,
      revision: run.revision,
      counts: run.counts,
      conversation_ai: run.conversationAi,
      calendar: run.calendar,
    })),
    total: runs.length,
    dir,
    errors,
    availability,
    status,
    quarantined,
    issues,
  });
}
