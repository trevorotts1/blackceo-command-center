import { NextRequest, NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';
import { detectPatternsAndPropose, type SOPProposalRow } from '@/lib/sop-learning';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/sops/proposals
 *
 * Query:
 *   ?status=pending|approved|rejected   (default: pending)
 *   ?department=<slug>                  optional filter
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || 'pending';
    const department = searchParams.get('department');

    let sql = 'SELECT * FROM sop_proposals WHERE status = ?';
    const params: unknown[] = [status];
    if (department) {
      sql += ' AND proposed_department = ?';
      params.push(department);
    }
    sql += ' ORDER BY created_at DESC';

    const rows = queryAll<SOPProposalRow>(sql, params);
    return NextResponse.json(rows);
  } catch (error) {
    console.error('[GET /api/sops/proposals] Failed:', error);
    return NextResponse.json({ error: 'Failed to fetch proposals' }, { status: 500 });
  }
}

/**
 * POST /api/sops/proposals
 *
 * Manually trigger pattern detection (the nightly cron also calls into the
 * same helper). Useful while testing and from the "Re-scan now" button on
 * the proposals page.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = detectPatternsAndPropose({
      lookback_days: typeof body.lookback_days === 'number' ? body.lookback_days : undefined,
      min_cluster_size: typeof body.min_cluster_size === 'number' ? body.min_cluster_size : undefined,
      min_unsoped_in_cluster: typeof body.min_unsoped_in_cluster === 'number' ? body.min_unsoped_in_cluster : undefined,
      max_proposals: typeof body.max_proposals === 'number' ? body.max_proposals : undefined,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('[POST /api/sops/proposals] Failed:', error);
    return NextResponse.json({ error: 'Failed to run pattern detection' }, { status: 500 });
  }
}
