/**
 * GET /api/operator/workspace/buckets
 *
 * Track B3 / SCOPE-ADDITION Addition 2.
 *
 * Two modes:
 *   - No query params: returns the 7-bucket summary (id, label, count, latest).
 *   - With ?bucket=<id>: returns the paginated item list for one bucket.
 *
 * Query params (when bucket is set):
 *   limit  (default 60, clamped 1..200)
 *   offset (default 0)
 */

import { NextRequest, NextResponse } from 'next/server';
import { BUCKETS, listBuckets, parseBucketId } from '@/lib/workspaces/buckets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const bucketParam = url.searchParams.get('bucket');
  const limit = clampInt(url.searchParams.get('limit'), 60, 1, 200);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);

  try {
    if (bucketParam) {
      const bucketId = parseBucketId(bucketParam);
      if (!bucketId) {
        return NextResponse.json(
          { error: 'invalid_bucket', valid: BUCKETS.map((b) => b.id) },
          { status: 400 }
        );
      }
      const listing = await listBuckets({ bucketId, limit, offset });
      return NextResponse.json({
        bucket: bucketId,
        summary: listing.summary,
        items: listing.items || [],
        total: listing.total,
        limit,
        offset,
      });
    }

    const listing = await listBuckets();
    return NextResponse.json({
      summary: listing.summary,
      total: listing.total,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'buckets_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
