import { NextRequest, NextResponse } from 'next/server';
import { getPodcastReadDb, resolvePodcastClientId } from '@/lib/podcast/db';
import { viewerFromRequest } from '@/lib/podcast/auth';
import { getJob, getJobEvents } from '@/lib/podcast/queries';
import {
  toClientEvents,
  toClientJob,
  toOperatorEvents,
  toOperatorJob,
} from '@/lib/podcast/serializers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/podcast/jobs/[job_id] -> { job, events }
 * Client sessions get the whitelist serialization and stage-transition
 * events only; operator sessions get the verbose shape (design Section 9).
 */
export async function GET(req: NextRequest, props: { params: Promise<{ job_id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  const viewer = viewerFromRequest(req);
  if (viewer.kind === 'none') {
    return NextResponse.json({ error: 'Access unavailable' }, { status: 401, headers: NO_STORE });
  }
  const db = getPodcastReadDb();
  const clientId = db ? resolvePodcastClientId(db) : null;
  // R-37: when the engine DB is absent, return 200 with an empty body shape the
  // client already handles (matching the list route's empty-state semantics).
  // Only 404 when the DB is live but the specific job does not exist.
  if (!db || !clientId) {
    return NextResponse.json(
      { job: null, events: [] },
      { headers: NO_STORE }
    );
  }
  const jobId = params.job_id;
  if (!/^pj_[A-Za-z0-9_-]+$/.test(jobId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
  }
  const row = getJob(db, clientId, jobId);
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
  }
  const events = getJobEvents(db, jobId);
  if (viewer.kind === 'operator') {
    return NextResponse.json(
      { job: toOperatorJob(row), events: toOperatorEvents(events) },
      { headers: NO_STORE }
    );
  }
  return NextResponse.json(
    { job: toClientJob(row), events: toClientEvents(events) },
    { headers: NO_STORE }
  );
}
