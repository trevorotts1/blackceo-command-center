import { NextRequest, NextResponse } from 'next/server';
import {
  resolvePublishCompany,
} from '@/lib/social/company-context';
import {
  lookupMediaAsset,
  signMediaPreviewToken,
  upsertMediaAsset,
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
 * POST /api/social/media/[assetId] — asset registration (ingest) + preview
 * token verification (media-server seam).
 *
 * D-F38-02 repair: upsertMediaAsset previously had no production caller (a
 * documented-but-unwired ingest seam). It is now wired here:
 *   - body { action: 'register', asset: {...} } → company-bound upsert of the
 *     URL-path assetId UNDER THE CALLER'S company (a B-company caller can only
 *     ever write B rows — the company_id comes from the verified identity,
 *     never the body), then 200 with the stored row;
 *   - otherwise (token/url body) → the original token-verification behavior:
 *     200 when the token is valid for THIS company + asset + url, 401 with
 *     `renewable: true` when expired so the player re-authenticates and
 *     re-fetches metadata instead of failing.
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

  let body: {
    action?: string;
    token?: string;
    url?: string;
    asset?: {
      cycle_id?: string | null;
      content_revision?: string | null;
      kind?: string;
      preview_url?: string | null;
      original_url?: string | null;
      poster_url?: string | null;
      duration_seconds?: number | null;
      ratio?: string | null;
      qc_state?: string | null;
    };
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (body.action === 'register') {
    if (!assetId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId)) {
      return NextResponse.json({ error: 'invalid asset id' }, { status: 400 });
    }
    const a = body.asset ?? {};
    const stored = upsertMediaAsset({
      id: assetId,
      company_id: companyId,
      cycle_id: a.cycle_id ?? null,
      content_revision: a.content_revision ?? null,
      kind: a.kind ?? 'video',
      preview_url: a.preview_url ?? null,
      original_url: a.original_url ?? null,
      poster_url: a.poster_url ?? null,
      duration_seconds: a.duration_seconds ?? null,
      ratio: a.ratio ?? null,
      qc_state: a.qc_state ?? null,
    });
    // Null = the id is owned by another company: refuse (409) without
    // touching or revealing the foreign row (no existence oracle).
    if (!stored) {
      return NextResponse.json({ error: 'asset id already registered' }, { status: 409 });
    }
    return NextResponse.json({ ok: true, asset: stored });
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