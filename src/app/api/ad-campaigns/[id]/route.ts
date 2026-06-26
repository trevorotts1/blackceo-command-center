import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { UpdateAdCampaignStageSchema } from '@/lib/validation';
import { moveAdStage, getAdCampaign, AdCampaignError, TransitionError } from '@/lib/ad-campaigns';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/ad-campaigns/[id] — move ONE stage card of an ad run. `[id]` = job_id
 * (== campaigns.id == tasks.campaign_id). Mirrors /api/campaigns/[id].
 *
 * Bearer auth handled globally by middleware; per-route HMAC mirrors ingest.
 * All moves route through the canonical transition() engine (in moveAdStage).
 */

// Copied verbatim from src/app/api/tasks/ingest/route.ts:76-82.
function verifyWebhookSignature(signature: string | null, rawBody: string): boolean {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) return true; // Dev mode — skip validation.
  if (!signature) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return signature === expected;
}

// PATCH /api/ad-campaigns/[id] — move a stage card to a new status.
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

  const validation = UpdateAdCampaignStageSchema.safeParse(parsed);
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: validation.error.issues },
      { status: 400 },
    );
  }

  try {
    const task = await moveAdStage(id, validation.data);
    return NextResponse.json({ task });
  } catch (err) {
    if (err instanceof AdCampaignError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    if (err instanceof TransitionError) {
      if (err.code === 'ILLEGAL_TRANSITION') {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
      }
      if (err.code === 'NOT_FOUND') {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
      }
      // Precondition failures etc.
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    console.error('[ad-campaigns PATCH] failed:', err);
    return NextResponse.json({ error: 'Failed to move ad stage' }, { status: 500 });
  }
}

// GET /api/ad-campaigns/[id] — fetch a run (campaign + cards) by job_id.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { campaign, cards } = getAdCampaign(id);
  if (!campaign) {
    return NextResponse.json({ error: 'ad campaign not found' }, { status: 404 });
  }
  return NextResponse.json({ campaign, cards });
}
