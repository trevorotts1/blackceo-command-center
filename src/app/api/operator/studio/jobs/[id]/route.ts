/**
 * GET /api/operator/studio/jobs/[id]
 *
 * Return a single Studio job by id. The UI polls this until status is
 * `succeeded` or `failed`.
 *
 * Track B4 (Operator Studio).
 */

import { NextRequest, NextResponse } from 'next/server';

import { loadJob } from '@/lib/studio/generators';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const job = await loadJob((await ctx.params).id);
  if (!job) {
    return NextResponse.json({ error: 'job_not_found', id: (await ctx.params).id }, { status: 404 });
  }
  return NextResponse.json({ job });
}
