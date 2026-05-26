/**
 * GET /api/system/status
 *
 * Returns the System Status Panel payload (PRD Section 3.12).
 *
 * Default: serves the cached snapshot from system_status_snapshots if it is
 * fresher than STATUS_CACHE_TTL_MS (30 seconds). Re-runs the probes only
 * when the cache is stale or missing.
 *
 * Query parameter `?force=1` bypasses the cache and re-runs every probe.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSystemStatus } from '@/lib/system-status';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get('force') === '1';
  try {
    const payload = await getSystemStatus({ force });
    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[/api/system/status] failed:', err);
    return NextResponse.json(
      {
        overall: 'offline',
        probedAt: new Date().toISOString(),
        components: [],
        fromCache: false,
        cacheAgeMs: null,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
