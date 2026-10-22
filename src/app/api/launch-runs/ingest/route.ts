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
 * the browser interface only ever GETs `/api/launch-runs` — and it is
 * self-authenticating like the Skill 71 ingest at `/api/skill-runs/ingest`:
 * the per-client Bearer in the handler is the ONLY gate. Per DB-CHANGES.md
 * ingest posture this route must NOT get a `src/lib/bearer-required-routes.ts`
 * pattern — stacking MC_API_TOKEN would force client producer boxes to hold
 * the operator token, which they must never hold. The middleware exempts
 * exactly `POST /api/launch-runs/ingest` (see src/middleware.ts) so the
 * handler's gate is reached; without a credential the handler answers 401,
 * so a forged same-origin header reaches it but authenticates nothing.
 */
export async function POST(request: NextRequest) {
  const result = handleLaunchIngest({
    authorization: request.headers.get('authorization'),
    body: await request.text(),
  });
  return NextResponse.json(result.payload, { status: result.status });
}
