import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { CreateAdCampaignSchema } from '@/lib/validation';
import { createAdCampaign, getAdCampaign } from '@/lib/ad-campaigns';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/ad-campaigns — Skill 48 (facebook-ad-generator) → board.
 *
 * Mirrors the existing /api/campaigns collection route. The Authorization:
 * Bearer <MC_API_TOKEN> layer is enforced globally by src/middleware.ts for
 * /api/* (no-op when MC_API_TOKEN is unset / same-origin). This route adds the
 * per-route HMAC scheme used by /api/tasks/ingest: x-webhook-signature =
 * HMAC-SHA256(WEBHOOK_SECRET, rawBody), no-op when WEBHOOK_SECRET is unset.
 */

// Copied verbatim from src/app/api/tasks/ingest/route.ts:76-82.
function verifyWebhookSignature(signature: string | null, rawBody: string): boolean {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) return true; // Dev mode — skip validation.
  if (!signature) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return signature === expected;
}

// POST /api/ad-campaigns — create an ad-run campaign + stage cards (idempotent on job_id).
export async function POST(request: NextRequest) {
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

  const validation = CreateAdCampaignSchema.safeParse(parsed);
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: validation.error.issues },
      { status: 400 },
    );
  }

  try {
    const result = createAdCampaign(validation.data);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    console.error('[ad-campaigns POST] failed:', err);
    return NextResponse.json({ error: 'Failed to create ad campaign' }, { status: 500 });
  }
}

// GET /api/ad-campaigns?job_id=<id> — poll a run (campaign + cards).
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get('job_id');
  if (!jobId) {
    return NextResponse.json({ error: 'job_id query param is required' }, { status: 400 });
  }
  const { campaign, cards } = getAdCampaign(jobId);
  if (!campaign) {
    return NextResponse.json({ error: 'ad campaign not found' }, { status: 404 });
  }
  return NextResponse.json({ campaign, cards });
}
