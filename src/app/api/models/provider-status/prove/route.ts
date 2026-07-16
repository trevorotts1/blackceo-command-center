import { NextRequest, NextResponse } from 'next/server';
import { getOrProveProviderAuth } from '@/lib/provider-auth-proof';
import { getProvider } from '@/lib/model-providers';
import { envCandidatesForProvider, resolveProviderApiKey } from '@/lib/provider-key-detection';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/models/provider-status/prove
 *
 * Body: { slug: string, force?: boolean }
 *
 * Runs (or returns a fresh cached) authenticated proof call for one provider —
 * see provider-auth-proof.ts for the full "kill the mirage" contract. This is
 * the ONLY place a real authenticated network call happens for this feature;
 * GET /api/models/provider-status only ever reads the cache it writes to.
 * Never returns the API key.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    const force = body?.force === true;
    if (!slug) {
      return NextResponse.json({ error: 'slug is required' }, { status: 400 });
    }

    const provider = getProvider(slug);
    if (!provider) {
      return NextResponse.json({ error: `unknown provider slug: ${slug}` }, { status: 404 });
    }
    if (provider.authType === 'local_endpoint') {
      return NextResponse.json({ error: 'local_endpoint providers do not use key-based auth proof' }, { status: 400 });
    }

    const candidates = envCandidatesForProvider(provider);
    const keyResult = resolveProviderApiKey(provider);
    if (!('found' in keyResult) || !keyResult.found) {
      return NextResponse.json(
        { error: 'no key found for this provider', checked: candidates },
        { status: 400 },
      );
    }

    const proof = await getOrProveProviderAuth(slug, keyResult.value, { force });
    return NextResponse.json({
      slug,
      ok: proof.ok,
      method: proof.method,
      modelId: proof.modelId,
      detail: proof.detail,
      provenAt: proof.provenAt,
      // `ok:false` alone was being read as "auth failed". failureKind says which
      // kind of false it is — critically, 'model_not_found' means the key was
      // never disproven (this box's model catalog is stale), NOT a bad key.
      failureKind: proof.failureKind,
      authDisproven: proof.failureKind === 'auth',
    });
  } catch (err) {
    console.error('[POST /api/models/provider-status/prove] failed:', err);
    return NextResponse.json(
      { error: 'Prove failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
