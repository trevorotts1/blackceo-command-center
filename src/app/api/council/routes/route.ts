import { NextResponse, type NextRequest } from 'next/server';
import { handleCouncil, modelsCatalogData } from '@/lib/council/api/foundation';
import { translateError } from '@/lib/council/api/errors';
import { assertNoConfiguredSecretsInPayload } from '@/lib/council/auth';
import { canonicalRouteIdForModel } from '@/lib/council/providers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/routes (CTR-191 canonical composer contract).
 *
 * The canonical chamber's New-question dialog calls this endpoint before it
 * offers a route (public/chamber/chamber-shell.js loadRoutes). It expects
 * `{ routes: [{ route_id, composable }], harness_defaults: { ... } }` at the
 * TOP level, so this adapter answers in that shape rather than the CC
 * `{ok,data}` envelope.
 *
 * Safety: the catalog is the caller's own installation registry
 * (modelsCatalogData is already tenant/company scoped for recorded probe
 * evidence). Only route ids, composability and the exact configured model id
 * leave this route. Credential presence internals, env-var names, provider
 * account references and every secret value stay server-side. A route is
 * composable only when its credential is present (or not required); nothing
 * is preselected and no fallback is offered.
 */
export async function GET(request: NextRequest) {
  return handleCouncil(request, async (ctx) => {
    try {
      // Only APPROVED routes: a fixed-model route whose credential is present
      // (or not required). An unconfigured or absent-credential row is not a
      // usable council route and is not exposed as a selectable option.
      const approved = modelsCatalogData(ctx).routes.filter(
        (entry) =>
          entry.kind === 'fixed_model' &&
          (entry.credential.state === 'present' ||
            entry.credential.state === 'not_required'),
      );
      const routes = approved
        .slice()
        .sort((a, b) => a.routeId.localeCompare(b.routeId))
        .map((entry) => ({
          // The raw host model id may contain '/', which canonical idSchema
          // forbids; this stable opaque id names the same catalog entry.
          route_id: canonicalRouteIdForModel(entry.routeId),
          composable: true,
        }));
      const harness_defaults: Record<string, { route_id: string; model: string }> = {};
      for (const entry of approved) {
        const canonicalId = canonicalRouteIdForModel(entry.routeId);
        harness_defaults[canonicalId] = {
          route_id: canonicalId,
          // The exact model this installation has configured for the route.
          // The canonical composer prints this verbatim; it is never a guess
          // and never a silent substitution.
          model: entry.modelId ?? entry.displayLabel,
        };
      }
      const payload = { routes, harness_defaults };
      assertNoConfiguredSecretsInPayload(payload);
      return NextResponse.json(payload, {
        headers: { 'cache-control': 'no-store' },
      });
    } catch (error) {
      const translated = translateError(error);
      return NextResponse.json(
        {
          code: translated.code,
          detail: translated.message,
          recovery:
            translated.action === 'fix_request'
              ? 'Reload the page; if the route catalog is still unavailable, open the service status page.'
              : 'Reload the page and try again.',
        },
        { status: translated.status, headers: { 'cache-control': 'no-store' } },
      );
    }
  });
}
