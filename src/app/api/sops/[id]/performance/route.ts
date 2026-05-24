import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { computePerformance } from '@/lib/sop-learning';

/**
 * GET /api/sops/[id]/performance?window=30
 *
 * Returns:
 *   score (sum(rating) / count), pos/neg/skip counts,
 *   sample notes (5 each), ranking signal (boost|flag|neutral),
 *   suggested revisions.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sop = queryOne<{ id: string }>('SELECT id FROM sops WHERE id = ?', [id]);
    if (!sop) return NextResponse.json({ error: 'sop not found' }, { status: 404 });

    const { searchParams } = new URL(req.url);
    const windowDays = Math.max(1, Math.min(365, Number(searchParams.get('window')) || 30));

    const report = computePerformance(id, windowDays);
    return NextResponse.json(report);
  } catch (error) {
    console.error('[GET /api/sops/:id/performance] Failed:', error);
    return NextResponse.json({ error: 'Failed to compute performance' }, { status: 500 });
  }
}
