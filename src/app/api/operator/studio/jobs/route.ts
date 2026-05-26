/**
 * GET /api/operator/studio/jobs
 *
 * List recent Studio jobs across all kinds. Optional query:
 *   - `kind` filter (image | video | audio)
 *   - `limit` (default 40)
 *
 * Track B4 (Operator Studio).
 */

import { NextRequest, NextResponse } from 'next/server';

import { listJobs } from '@/lib/studio/generators';
import type { StudioKind } from '@/lib/studio/generators';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') as StudioKind | null;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '40'), 1), 200);

  const jobs = await listJobs(limit);
  const filtered = kind ? jobs.filter((j) => j.kind === kind) : jobs;
  return NextResponse.json({ jobs: filtered });
}
