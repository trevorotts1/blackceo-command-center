import { NextRequest, NextResponse } from 'next/server';
import {
  resolvePublishCompany,
} from '@/lib/social/company-context';
import {
  lookupMediaAsset,
  signMediaPreviewToken,
  verifyMediaPreviewToken,
} from '@/lib/social/media-assets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/social/media/[assetId]
 *
 * F38 — company-bound media lookup + renewable preview access for the sheet's
 * "Watch video" link.
 *
 * The caller's company identity is resolved from the authenticated request
 * context (resolvePublishCompany — bearer MC_API_TOKEN / signed tenant session
 * / CF Access JWT; the SAME seam every other company-scoped route uses). The
 * asset is then looked up bound to THAT company:
 *   - foreign or absent assetId → 404 with zero bytes (no existence oracle),
 *   - authenticated + owned → a SHORT-LIVED signed preview token bound to
 *     company + asset + url, plus the metadata the player renders (poster,
 *     duration, ratio, revision, QC state). A leaked link expires and is
 *     renewed by re-fetching this route while still authenticated — QC-F38's
 *     "expired preview is renewable" path.
 *
 * ?preview_url=<url> targets a specific URL (default: preview_url, falling
 * back to original_url). The signed token is verified at the media fetch; the
 * player page re-fetches metadata here on expiry.
 */
export async function GET(
  request: NextRequest,
  props: { params: Promise<{ assetId: string }> },
) {
  const identity = await resolvePublishCompany(request);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const { companyId } = identity.company;
  const { assetId } = await props.params;

  // Company-bound lookup — a substituted B-company assetId is foreign to A.
  const asset = lookupMediaAsset(assetId, companyId);
  if (!asset) {
    return NextResponse.json({ error: 'asset not found' }, { status: 404 });
  }

  const targetUrl = new URL(request.url).searchParams.get('preview_url') ||
    asset.preview_url || asset.original_url || '';
  if (!targetUrl) {
    return NextResponse.json(
      { error: 'asset has no preview URL yet', repair_state: 'asset_missing_url' },
      { status: 409 },
    );
  }

  const { token, expiresAt } = await signMediaPreviewToken(companyId, assetId, targetUrl);

  return NextResponse.json({
    asset: {
      id: asset.id,
      kind: asset.kind,
      cycle_id: asset.cycle_id,
      content_revision: asset.content_revision,
      poster_url: asset.poster_url,
      duration_seconds: asset.duration_seconds,
      ratio: asset.ratio,
      qc_state: asset.qc_state,
      watch_url: targetUrl,
    },
    preview: {
      url: targetUrl,
      token,
      expires_at: new Date(expiresAt).toISOString(),
      renewal: 'Re-fetch this endpoint while authenticated to renew expired preview access.',
    },
  });
}

/**
 * POST /api/social/media/[assetId] — verify a preview token (media-server
 * seam). Returns 200 when the token is valid for THIS company + asset + url;
 * 401 with `renewable: true` when expired so the player re-authenticates and
 * re-fetches metadata instead of failing.
 */
export async function POST(
  request: NextRequest,
  props: { params: Promise<{ assetId: string }> },
) {
  const identity = await resolvePublishCompany(request);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const { companyId } = identity.company;
  const { assetId } = await props.params;

  let body: { token?: string; url?: string };
  try {
    body = (await request.json()) as { token?: string; url?: string };
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const asset = lookupMediaAsset(assetId, companyId);
  if (!asset) {
    return NextResponse.json({ error: 'asset not found' }, { status: 404 });
  }
  const url = body.url || asset.preview_url || asset.original_url || '';
  const ok = await verifyMediaPreviewToken(body.token || null, companyId, assetId, url);
  if (!ok) {
    return NextResponse.json(
      {
        error: 'preview access expired or invalid',
        renewable: true,
        renewal: 'Re-fetch GET /api/social/media/' + assetId + ' while authenticated to mint a fresh preview token.',
      },
      { status: 401 },
    );
  }
  return NextResponse.json({ ok: true, url });
}