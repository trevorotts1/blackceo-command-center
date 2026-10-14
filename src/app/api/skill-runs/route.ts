import { NextRequest, NextResponse } from 'next/server';
import { getSkill71Run, listSkill71Runs } from '@/lib/skill71-runs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/skill-runs: Skill 71 (signature page) runs, read side.
 *
 * Serves the CC database only (populated by event ingestion: the file
 * importer scripts/import-skill71-runs.ts and POST
 * /api/skill-runs/ingest). This route never reaches into run folders at
 * request time: a run whose events were never delivered is absent, and
 * that absence is meaningful (fleet-mac runs are local by default unless
 * the deployment opted into visibility).
 *
 * GET /api/skill-runs                       → newest-first list
 *   ?status=complete|incomplete|test-run    filter on overall
 *   ?brand=<brand_id>&client=<client>      filters
 *   ?host_shape=fleet-mac|fleet-hostinger|fleet-contabo
 *   ?limit=<n>&offset=<n>                   pagination (limit ≤ 200)
 * GET /api/skill-runs?run_id=<uuid>        → one run + all 13 stage rows
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get('run_id');

  if (runId) {
    const detail = getSkill71Run(runId);
    if (!detail) {
      return NextResponse.json({ error: 'skill71 run not found' }, { status: 404 });
    }
    return NextResponse.json(detail);
  }

  const limitRaw = Number(searchParams.get('limit') ?? 50);
  const offsetRaw = Number(searchParams.get('offset') ?? 0);
  const { runs, total } = listSkill71Runs({
    overall: searchParams.get('status') ?? undefined,
    brand_id: searchParams.get('brand') ?? undefined,
    client: searchParams.get('client') ?? undefined,
    host_shape: searchParams.get('host_shape') ?? undefined,
    limit: Number.isFinite(limitRaw) ? limitRaw : 50,
    offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
  });
  return NextResponse.json({ runs, total });
}
