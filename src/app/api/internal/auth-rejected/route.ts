/**
 * INTERNAL 401 sink — the Node-runtime half of the middleware 401 telemetry
 * (FLEET-FIX 2.3 / AUD-71). NOT a public endpoint.
 *
 * `src/middleware.ts` runs in the Edge runtime and therefore cannot write any
 * state a Node health route can read (see `unauthorized-401-contract.ts` for the
 * full explanation). So for every CREDENTIAL-FAILURE 401 it rewrites the
 * rejected request here instead. This handler is the request's final stop:
 *
 *   1. increments the authoritative counter (Node-runtime, globalThis-backed),
 *   2. emits the ONE structured `console.error` line — carrying the pathname,
 *      method, discriminated reason, caller UA, and the real running count,
 *   3. returns the EXACT response the middleware used to return itself:
 *      `401 {"error":"Unauthorized"}`.
 *
 * The caller sees no difference. The rewrite is dispatched in-process by Next
 * and does not re-enter the middleware, so there is no loop and no network hop.
 *
 * REACHABILITY: `src/middleware.ts` answers any DIRECT inbound request for this
 * path with a 404 before any auth logic runs. The only way to reach this handler
 * is the middleware's own rewrite. That is what stops an outside caller from
 * inflating the counter or poisoning the per-reason breakdown by hand-crafting
 * the `x-cc-auth-reject-*` headers. The `parseCredentialFailureReason()` guard
 * below is the second belt: an absent/unknown/forged reason is NOT counted.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  AUTH_REJECT_HEADERS,
  logUnauthorized401,
  parseCredentialFailureReason,
  sanitizeHeaderValue,
} from '@/lib/probes/unauthorized-401-contract';
import { recordUnauthorized401 } from '@/lib/probes/unauthorized-401-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The literal body + status the middleware's `unauthorized()` helper produced
 * before this route existed. Keeping it here — and returning it unconditionally,
 * even if the telemetry side throws — is what makes the telemetry unable to
 * change auth semantics. Telemetry is never allowed to turn a 401 into a 500.
 */
function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function handle(request: NextRequest): NextResponse {
  try {
    const h = request.headers;
    const reason = parseCredentialFailureReason(h.get(AUTH_REJECT_HEADERS.reason));

    // No/unknown reason => this request did not arrive through the middleware's
    // rewrite with a recognised credential-failure signal. Answer 401 (the caller
    // is unauthenticated either way) but do NOT count it: a counter that accepts
    // whatever it is handed is a counter that lies.
    if (reason === null) return unauthorizedResponse();

    const event = {
      pathname: sanitizeHeaderValue(h.get(AUTH_REJECT_HEADERS.pathname), 512) ?? 'unknown',
      method: sanitizeHeaderValue(h.get(AUTH_REJECT_HEADERS.method), 16) ?? request.method,
      reason,
      ua: sanitizeHeaderValue(h.get(AUTH_REJECT_HEADERS.ua)),
      ts: new Date().toISOString(),
    };

    const count = recordUnauthorized401(event);
    logUnauthorized401(event, count, 'node-sink');
  } catch (err) {
    // A telemetry fault must never escalate a 401 into a 500 for the caller.
    console.error('[401-telemetry] sink failed to record a credential-failure 401:', err);
  }

  return unauthorizedResponse();
}

// Every method in REWRITABLE_METHODS (unauthorized-401-contract.ts) must be
// exported here, or Next answers the rewritten request with 405 instead of the
// 401 the caller is owed. Keep the two lists in lockstep.
export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
