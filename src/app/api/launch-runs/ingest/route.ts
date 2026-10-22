import { NextRequest, NextResponse } from 'next/server';
import { handleLaunchIngest } from '@/lib/launch-transport';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/launch-runs/ingest — authenticated launch-ingest transport.
 *
 * One handler, three event families, one gate (see `handleLaunchIngest` in
 * `src/lib/launch-transport.ts`):
 *   { "events": [...] }                 → launch run events
 *   { "progress": <sample> }            → one launch progress sample
 *   { "samples": [<sample>, ...] }      → launch progress samples
 *   a single object (either family)     → accepted directly
 *   JSONL, one object per line          → accepted directly
 *
 * AUTH: `Authorization: Bearer <per-client token>` (the SAME
 * `skill71_ingest_tokens` hash-only store the Skill 71 transport uses — no
 * new credential surface). An event or sample that CONTRADICTS the token's
 * client slug, host shape or installation is rejected before a row is
 * written. Delivery is at-least-once: duplicates (same event_id / identical
 * sample bytes) are reported as duplicates, never errors.
 *
 * NOTE (U052 census): this POST is a service-to-service producer ingest —
 * the browser interface only ever GETs `/api/launch-runs` — so it is now
 * registered in the bearer census in `src/lib/bearer-required-routes.ts`
 * (2026-10-21 entry; the re-derived census landed with it in
 * `src/lib/__tests__/passthrough-write-scope.test.ts`). The route still
 * enforces its own per-client Bearer token in the handler. RESIDUAL: the
 * per-client ingest token (skill71_ingest_tokens) is not one of the identities
 * `resolveTenantContext` accepts, so the middleware layer admits only
 * MC_API_TOKEN / session-cookie / verified-Access callers past this point —
 * see the lane note for the token-contract reconciliation.
 */
export async function POST(request: NextRequest) {
  const result = handleLaunchIngest({
    authorization: request.headers.get('authorization'),
    body: await request.text(),
  });
  return NextResponse.json(result.payload, { status: result.status });
}
