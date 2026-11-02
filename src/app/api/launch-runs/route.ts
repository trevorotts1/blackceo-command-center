import { NextRequest, NextResponse } from 'next/server';
import {
  launchPlansDirConfigured,
  listIngestedLaunches,
  listLaunchRuns,
  NOT_INCLUDED_LABEL,
  type IngestedLaunch,
} from '@/lib/launch-runs';
import { getLaunchRun as getIngestedRun, LaunchStoreUnavailableError } from '@/lib/launch-ability-runs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/launch-runs: launch automation runs, read side. Serves BOTH views: the
 * DISK view (approved plan + producer progress files) and the DATABASE view
 * (runs the skills reported through the ingest transport, keyed by launch_id,
 * available with LAUNCH_PLANS_DIR unset). Read-only: no ingest, no writes, no
 * sends, no account calls.
 *
 * GET /api/launch-runs                  → newest-first list with percentage
 * GET /api/launch-runs?launch_id=<id>   → one run (units, states, percentage)
 *
 * Honesty contract:
 *   - an unset LAUNCH_PLANS_DIR is not a fault (the disk view is empty); a
 *     configured but unreadable plans directory answers 503 `launch_store_unavailable`,
 *     never `runs: []` (which would read as "no launches");
 *   - a quarantined run returns `availability: "quarantined"`, zero completion
 *     and the actionable `issues` that stopped it;
 *   - a plan section that does not exist returns the neutral
 *     `not_included_label` ("Not included"), never 0/0 as if it were planned.
 */
function ingestedBody(launch: IngestedLaunch) {
  return {
    launch_id: launch.launchId,
    last_event_at: launch.lastEventAt,
    abilities: launch.abilities.map((ability) => ({
      skill: ability.skill,
      name: ability.name,
      run_id: ability.runId,
      stages_closed: ability.stagesClosed,
      stages_total: ability.stagesTotal,
      percentage: ability.percentage,
      blocked_stages: ability.blockedStages,
      next_stage: ability.nextStage,
      last_event_at: ability.lastEventAt,
    })),
  };
}

function unavailable(detail: unknown, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: 'launch_store_unavailable', detail, ...extra }, { status: 503 });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const launchId = searchParams.get('launch_id');

  const disk = listLaunchRuns();
  // Unset LAUNCH_PLANS_DIR: the disk view is simply empty, never a 503.
  const diskUsable = disk.availability !== 'unavailable' || !launchPlansDirConfigured();
  const diskRuns = diskUsable && disk.availability !== 'unavailable' ? disk.runs : [];

  if (launchId) {
    const run = diskRuns.find((entry) => entry.launchId === launchId);
    if (run) return NextResponse.json(run);
    if (!diskUsable) return unavailable(disk.errors, { availability: disk.availability });

    const ingested = listIngestedLaunches();
    if (ingested.availability === 'unavailable') return unavailable(ingested.error);
    const launch = ingested.launches.find((entry) => entry.launchId === launchId);
    if (!launch) {
      return NextResponse.json(
        { error: 'launch run not found', availability: disk.availability, status: disk.status },
        { status: 404 },
      );
    }
    try {
      const body = ingestedBody(launch);
      return NextResponse.json({
        ...body,
        source: 'database',
        abilities: body.abilities.map((ability) => ({
          ...ability,
          stages: (getIngestedRun(ability.run_id)?.stages ?? []).map(({ stage, status, receipt_status }) => ({
            stage,
            status,
            receipt_status,
          })),
        })),
      });
    } catch (error) {
      if (error instanceof LaunchStoreUnavailableError) return unavailable(error.message);
      throw error;
    }
  }

  const { dir, errors, availability, status, issues, quarantined } = disk;
  if (!diskUsable) return unavailable(errors, { availability, status, dir });
  const ingested = listIngestedLaunches();
  // Never an empty list that reads as "no launches" when nothing could be read.
  if (ingested.availability === 'unavailable' && diskRuns.length === 0 && availability === 'unavailable') {
    return unavailable(ingested.error);
  }
  return NextResponse.json({
    runs: diskRuns.map((run) => ({
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
    total: diskRuns.length,
    ingested: ingested.launches.map(ingestedBody),
    ingested_total: ingested.launches.length,
    ingested_availability: ingested.availability,
    dir,
    errors,
    availability,
    status,
    quarantined,
    issues,
  });
}
