import { NextRequest, NextResponse } from 'next/server';
import { UpdateArchifyRunPhaseSchema } from '@/lib/validation';
import { moveArchifyPhase, getArchifyRun, ArchifyRunError, TransitionError } from '@/lib/archify-runs';
import { verifyWebhookSignature } from '@/lib/webhook-signature';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/archify-runs/[id] — move ONE phase card of an archify run.
 * `[id]` = run_id (== campaigns.id == tasks.campaign_id).
 *
 * Structural mirror of /api/ad-campaigns/[id]. Bearer auth is handled globally
 * by middleware (this route is listed in src/lib/bearer-required-routes.ts);
 * the per-route HMAC mirrors /api/tasks/ingest via the shared constant-time
 * verifyWebhookSignature(). All moves route through the canonical transition()
 * engine inside moveArchifyPhase — the legal map, task_events and SSE all apply
 * exactly as they do for every other board card.
 */

// PATCH /api/archify-runs/[id] — move a phase card to a new status, optionally
// recording a note and registering the phase's artifact as completion evidence.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rawBody = await request.text();

  if (!verifyWebhookSignature(request.headers.get('x-webhook-signature'), rawBody)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validation = UpdateArchifyRunPhaseSchema.safeParse(parsed);
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: validation.error.issues },
      { status: 400 },
    );
  }

  try {
    const task = await moveArchifyPhase(id, validation.data);
    return NextResponse.json({ task });
  } catch (err) {
    if (err instanceof ArchifyRunError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    if (err instanceof TransitionError) {
      if (err.code === 'ILLEGAL_TRANSITION') {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
      }
      if (err.code === 'NOT_FOUND') {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
      }
      // Precondition failures (e.g. PRECONDITION_EVIDENCE from the review/done
      // gates) etc. — 422, with the transition engine's actionable message.
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    console.error('[archify-runs PATCH] failed:', err);
    return NextResponse.json({ error: 'Failed to move archify phase' }, { status: 500 });
  }
}

// GET /api/archify-runs/[id] — fetch a run (grouping + cards + phases).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { campaign, cards, phases } = getArchifyRun(id);
  if (!campaign) {
    return NextResponse.json({ error: 'archify run not found' }, { status: 404 });
  }
  return NextResponse.json({ campaign, cards, phases });
}
