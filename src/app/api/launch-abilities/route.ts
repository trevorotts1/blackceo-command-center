import { NextRequest, NextResponse } from 'next/server';
import { LAUNCH_ABILITIES, getLaunchAbility } from '@/lib/launch-abilities';
import {
  getLaunchProgressSamples,
  getLaunchRun,
  listLaunchRuns,
  launchAbilityOverview,
  LaunchStoreUnavailableError,
} from '@/lib/launch-ability-runs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/launch-abilities — launch ability registration + run/progress read side.
 *
 * Registers the five launch abilities (49/50/44/38/83) and serves the runs and
 * progress they emit. Ingestion feeds the same Command Center database through
 * src/lib/launch-ability-runs.ts (the launch twin of the Skill 71 run core) and
 * the frozen run-events contract — this route never reaches into run folders.
 *
 * GET /api/launch-abilities                       → every ability + its newest runs
 * GET /api/launch-abilities?skill=49              → one ability + its runs
 * GET /api/launch-abilities?launch_id=<id>        → every ability's runs for one
 *                                                   launch + its progress samples
 * GET /api/launch-abilities?run_id=<uuid>         → one run + stage rows + progress
 *
 * Filters on the list: ?status=complete|incomplete|test-run  ?client=<slug>
 *                      ?host_shape=fleet-mac|fleet-hostinger|fleet-contabo
 *                      ?limit=<n>&offset=<n>            (limit ≤ 200)
 *
 * READ ONLY by design: this lane adds no mutating route, so it adds nothing to
 * the bearer-required write census (src/lib/bearer-required-routes.ts).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const runId = searchParams.get('run_id');
  if (runId) {
    let detail;
    try {
      detail = getLaunchRun(runId);
    } catch (error) {
      if (error instanceof LaunchStoreUnavailableError) {
        return NextResponse.json(
          { error: 'launch_store_unavailable', detail: error.message },
          { status: 503 },
        );
      }
      throw error;
    }
    if (!detail) {
      return NextResponse.json({ error: 'launch run not found' }, { status: 404 });
    }
    return NextResponse.json(detail);
  }

  const limitRaw = Number(searchParams.get('limit') ?? 50);
  const offsetRaw = Number(searchParams.get('offset') ?? 0);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
  const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;
  const status = searchParams.get('status') ?? undefined;
  const client = searchParams.get('client') ?? undefined;
  const hostShape = searchParams.get('host_shape') ?? undefined;

  const launchId = searchParams.get('launch_id');
  if (launchId) {
    const page = listLaunchRuns({
      launch_id: launchId, status, client_slug: client, host_shape: hostShape, limit, offset,
    });
    if (page.availability === 'unavailable') {
      return NextResponse.json(
        { error: 'launch_store_unavailable', detail: page.error ?? null },
        { status: 503 },
      );
    }
    return NextResponse.json({
      launch_id: launchId,
      runs: page.runs,
      total: page.total,
      availability: page.availability,
      progress_samples: getLaunchProgressSamples(launchId),
    });
  }

  const skillParam = searchParams.get('skill');
  if (skillParam !== null) {
    const ability = getLaunchAbility(skillParam);
    if (!ability) {
      return NextResponse.json(
        { error: 'unknown launch ability', registered: LAUNCH_ABILITIES.map((a) => a.skill) },
        { status: 404 },
      );
    }
    const page = listLaunchRuns({
      skill: ability.skill, status, client_slug: client, host_shape: hostShape, limit, offset,
    });
    if (page.availability === 'unavailable') {
      return NextResponse.json(
        { error: 'launch_store_unavailable', detail: page.error ?? null },
        { status: 503 },
      );
    }
    return NextResponse.json({ ability, runs: page.runs, total: page.total, availability: page.availability });
  }

  return NextResponse.json({
    abilities: launchAbilityOverview(Math.min(Math.max(limit, 1), 20)),
  });
}
