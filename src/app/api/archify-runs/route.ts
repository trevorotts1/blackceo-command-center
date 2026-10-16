import { NextRequest, NextResponse } from 'next/server';
import { CreateArchifyRunSchema } from '@/lib/validation';
import { createArchifyRun, getArchifyRun, resolveRunIdByExternalId, ArchifyRunError } from '@/lib/archify-runs';
import { verifyWebhookSignature } from '@/lib/webhook-signature';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/archify-runs — Skill 69 (archify) → board.
 *
 * Structural mirror of /api/ad-campaigns (Skill 48 → board). An external
 * producer creates ONE archify diagram run as ONE board grouping (`campaigns`
 * row) with one card per phase (received → authoring → validate → render →
 * deliver — the Skill 69 producer's OWN PHASES vocabulary, mirrored verbatim by
 * DEFAULT_ARCHIFY_PHASES so a create that omits `phases` still yields cards its
 * `--phase` CLI can address), then drives those cards via
 * PATCH /api/archify-runs/[id].
 *
 * AUTH PARITY (both layers, same as /api/ad-campaigns):
 *   1. `Authorization: Bearer <MC_API_TOKEN>` — enforced globally by
 *      src/middleware.ts for bearer-required write routes (no-op for
 *      same-origin / when MC_API_TOKEN is unset). This route is registered in
 *      src/lib/bearer-required-routes.ts, which is what the middleware consults.
 *   2. `x-webhook-signature: HMAC-SHA256(WEBHOOK_SECRET, rawBody)` hex — the
 *      per-route layer, verified over the EXACT bytes received (request.text()).
 *      No-ops when WEBHOOK_SECRET is unset (dev mode).
 *
 * The HMAC check calls the shared `verifyWebhookSignature()` — the single
 * constant-time implementation (FIX 56) that /api/tasks/ingest itself now
 * imports — rather than adding a fourth copy of the old `===` string compare.
 * Its semantics are IDENTICAL to the local copy in the ad-campaigns routes:
 * unset secret ⇒ skip (dev mode); absent/ wrong / wrong-length signature ⇒ 401.
 */

// POST /api/archify-runs — create an archify run + phase cards.
// Idempotent on run_id (or on a deterministic id derived from external_run_id),
// so a producer retry can never double-create. Replay ⇒ 200 {created:false};
// same id with different parameters ⇒ 409 IDEMPOTENCY_CONFLICT.
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

  const validation = CreateArchifyRunSchema.safeParse(parsed);
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: validation.error.issues },
      { status: 400 },
    );
  }

  try {
    const result = createArchifyRun(validation.data);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    if (err instanceof ArchifyRunError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error('[archify-runs POST] failed:', err);
    return NextResponse.json({ error: 'Failed to create archify run' }, { status: 500 });
  }
}

// GET /api/archify-runs?run_id=<id> — poll a run (grouping + cards + phases).
// Also accepts ?external_run_id=<id>, which resolves through the SAME
// deterministic derivation the create path uses (never a fuzzy match).
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get('run_id');
  const externalRunId = searchParams.get('external_run_id');

  if (!runId && !externalRunId) {
    return NextResponse.json(
      { error: 'run_id query param is required (or external_run_id)' },
      { status: 400 },
    );
  }

  const resolved = runId ?? resolveRunIdByExternalId(externalRunId as string);
  if (!resolved) {
    return NextResponse.json({ error: 'archify run not found' }, { status: 404 });
  }

  const { campaign, cards, phases } = getArchifyRun(resolved);
  if (!campaign) {
    return NextResponse.json({ error: 'archify run not found' }, { status: 404 });
  }
  return NextResponse.json({ campaign, cards, phases });
}
