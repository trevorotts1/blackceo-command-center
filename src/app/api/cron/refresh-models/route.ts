import { NextRequest, NextResponse } from 'next/server';
import { refreshModels } from '@/lib/jobs/refresh-models';
import { hydrateProviderEnvForSelectedClient } from '@/lib/studio/provider-discovery';

export const dynamic = 'force-dynamic';
// Refresh can take a while when iterating every provider; raise the function
// timeout above the default for platforms that honor this hint.
export const maxDuration = 300;

/**
 * Optional shared-secret auth. Set `CRON_SECRET` in env and pass either
 * `?token=...` or `Authorization: Bearer ...`. If unset, runs unauthenticated.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const url = new URL(req.url);
  const tokenParam = url.searchParams.get('token');
  const auth = req.headers.get('authorization') || '';
  const tokenHeader = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return tokenParam === secret || tokenHeader === secret;
}

/**
 * POST /api/cron/refresh-models
 *
 * Manually trigger the weekly model registry refresh. Returns counts per
 * provider plus a roll-up of how many providers were refreshed.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const startedAt = new Date().toISOString();
    // E4: source provider keys from the SELECTED client (local files for self,
    // remote openclaw.json/.env over the SSH tunnel for a remote client) so the
    // refresh pulls THAT tenant's catalog — not the Command Center's own env.
    // Best-effort: a hydration failure must not block the refresh.
    try {
      await hydrateProviderEnvForSelectedClient();
    } catch (err) {
      console.warn('[refresh-models] client key hydration failed (continuing):', err);
    }
    const outcomes = await refreshModels();
    const successful = outcomes.filter((o) => o.success).length;
    const failed = outcomes.length - successful;

    return NextResponse.json({
      ok: true,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      providers_refreshed: outcomes.length,
      providers_succeeded: successful,
      providers_failed: failed,
      outcomes,
    });
  } catch (error) {
    console.error('[POST /api/cron/refresh-models] Failed:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

/**
 * GET /api/cron/refresh-models — READ-ONLY. Never mutates.
 *
 * MODEL-07: this used to be `return POST(req)` — a plain browser visit to this
 * URL ran a full destructive catalog refresh. Combined with the self-destruct
 * deprecation bug, merely opening the URL could tombstone the entire model
 * registry. A GET must be safe: HTTP semantics require it, and nothing in the
 * codebase ever called this handler (the "Refresh now" button in
 * IntelligenceProviderList.tsx correctly uses POST, and the weekly refresh runs
 * in-process via the scheduler — not through this route).
 *
 * It now returns 405 and tells the caller how to actually trigger a refresh.
 */
export async function GET() {
  return NextResponse.json(
    {
      error: 'method_not_allowed',
      message:
        'GET does not refresh the model catalog — a refresh is destructive and must not run on a read. Use POST /api/cron/refresh-models.',
    },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
