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
 * the browser interface only ever GETs `/api/launch-runs` — so it needs a
 * bearer pattern in `src/lib/bearer-required-routes.ts` and a re-derived
 * census in `src/lib/__tests__/passthrough-write-scope.test.ts`. Both files
 * are shared and owned by other lanes; the mount here keeps the handler
 * reachable and self-authenticating, and the census update rides with the
 * lane that owns those files. Until that lands, this route still enforces
 * its own per-client Bearer token in the handler (a forged same-origin
 * header reaches it without a credential but gets a 401 with no token).
 */
export async function POST(request: NextRequest) {
  const result = handleLaunchIngest({
    authorization: request.headers.get('authorization'),
    body: await request.text(),
  });
  return NextResponse.json(result.payload, { status: result.status });
}
