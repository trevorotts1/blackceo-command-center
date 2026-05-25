import { NextRequest, NextResponse } from 'next/server';
import { refreshModels } from '@/lib/jobs/refresh-models';

export const dynamic = 'force-dynamic';
// Refresh can take a while when iterating every provider; raise the function
// timeout above the default for platforms that honor this hint.
export const maxDuration = 300;

/**
 * Optional shared-secret auth. Set `CRON_SECRET` in env and pass either
 * `?token=...` or `Authorization: Bearer ...`. If unset, runs unauthenticated.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const url = new URL(req.url);
  const tokenParam = url.searchParams.get('token');
  const auth = req.headers.get('authorization') || '';
  const tokenHeader = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return tokenParam === secret || tokenHeader === secret;
}

/**
 * POST /api/cron/refresh-models
 *
 * Manually trigger the weekly model registry refresh. Returns counts per
 * provider plus a roll-up of how many providers were refreshed.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const startedAt = new Date().toISOString();
    const outcomes = await refreshModels();
    const successful = outcomes.filter((o) => o.success).length;
    const failed = outcomes.length - successful;

    return NextResponse.json({
      ok: true,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      providers_refreshed: outcomes.length,
      providers_succeeded: successful,
      providers_failed: failed,
      outcomes,
    });
  } catch (error) {
    console.error('[POST /api/cron/refresh-models] Failed:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

/**
 * GET handler so the route is also reachable from a browser or external cron
 * that only supports GET. Behaves identically to POST.
 */
export async function GET(req: NextRequest) {
  return POST(req);
}
