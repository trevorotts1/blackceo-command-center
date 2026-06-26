import { NextRequest, NextResponse } from 'next/server';
import { recordCfAccessSeen } from '@/lib/probes/cloudflare-access-probe';

/**
 * Layered authentication middleware per PRD Section 3.1 (Fix #1).
 *
 * Two independent auth layers protect this deployment:
 *
 *   1. Cloudflare Access (page + API). Cloudflare sits in front of the
 *      subdomain and gates ALL traffic. Authenticated requests arrive with
 *      `Cf-Access-Jwt-Assertion` and `Cf-Access-Authenticated-User-Email`
 *      headers populated. The Next.js app never validates the JWT itself
 *      (Cloudflare already did that), it just checks that the headers are
 *      present and surfaces the email to downstream code via the request
 *      headers.
 *
 *   2. MC_API_TOKEN (API only). A long-lived bearer token used by external
 *      integrations (CLIs, scripts, OpenClaw, SSE consumers) that cannot go
 *      through the Cloudflare Access browser flow. Same-origin browser
 *      requests do NOT need the bearer token because Cloudflare Access
 *      already gates them.
 *
 * Bypass routes:
 *   - `/api/health` (Cloudflare health checks) bypasses both layers.
 *
 * Fail-closed posture (G15-AUTH-HARDEN):
 *   - When MC_API_TOKEN is unset, EXTERNAL (non-same-origin) /api/* callers
 *     are REJECTED with a 503 misconfiguration error instead of being let
 *     through. Same-origin browser requests still work because Cloudflare
 *     Access (layer 1) gates them.
 *   - The webhook routes in WEBHOOK_SECRET_ROUTES (ingest + agent-completion)
 *     are REJECTED with a 503 when WEBHOOK_SECRET is unset, because their
 *     route-level HMAC check authenticates nothing without the secret.
 *   - An operator may set ALLOW_INSECURE_OPEN_API=true to restore the legacy
 *     open behavior on a not-yet-provisioned box. This is logged loudly and
 *     is a temporary bridge, not a supported production mode.
 *
 * Production misconfiguration (Cloudflare Access not enabled on the
 * subdomain) returns 401 with a clear error message so the operator knows
 * exactly what to fix.
 */

const MC_API_TOKEN = process.env.MC_API_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const REQUIRE_CF_ACCESS = process.env.REQUIRE_CF_ACCESS === 'true';
const DEMO_MODE = process.env.DEMO_MODE === 'true';

/**
 * Escape hatch for fail-closed auth (G15-AUTH-HARDEN).
 *
 * The legacy behavior silently allowed ALL external /api/* traffic when
 * MC_API_TOKEN was unset, and skipped webhook HMAC when WEBHOOK_SECRET was
 * unset. A client box missing both env vars plus any Cloudflare Access
 * misconfiguration = a fully open ingest/completion surface. We now fail
 * CLOSED by default: missing secrets reject external callers with a clear
 * 503 misconfiguration error.
 *
 * To avoid locking out a box that genuinely still relies on the old open
 * default, an operator may set ALLOW_INSECURE_OPEN_API=true to restore the
 * legacy open behavior. This is logged loudly at startup and is NOT
 * recommended — it exists only as a documented, reversible bridge.
 */
const ALLOW_INSECURE_OPEN_API = process.env.ALLOW_INSECURE_OPEN_API === 'true';

/**
 * Routes that accept EXTERNAL (non-Cloudflare-Access) webhook callers and
 * authenticate purely via HMAC-SHA256 over WEBHOOK_SECRET. If the secret is
 * absent the route-level HMAC check authenticates nothing, so these routes
 * must be refused at the gate unless the operator has opted into open mode.
 */
const WEBHOOK_SECRET_ROUTES = ['/api/tasks/ingest', '/api/webhooks/agent-completion'];

function matchesRoute(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

if (DEMO_MODE) {
  console.log('[DEMO] Running in demo mode, all write operations are blocked');
} else {
  // MC_API_TOKEN — external /api/* bearer auth.
  if (!MC_API_TOKEN) {
    if (ALLOW_INSECURE_OPEN_API) {
      console.warn('[SECURITY WARNING] MC_API_TOKEN not set AND ALLOW_INSECURE_OPEN_API=true — external /api/* auth is DISABLED. Provision MC_API_TOKEN and remove ALLOW_INSECURE_OPEN_API.');
    } else {
      console.error('[SECURITY ERROR] MC_API_TOKEN not set — external /api/* callers will be REJECTED (fail-closed). Set MC_API_TOKEN in production, or set ALLOW_INSECURE_OPEN_API=true to restore the legacy open behavior (NOT recommended).');
    }
  }
  // WEBHOOK_SECRET — ingest + agent-completion HMAC.
  if (!WEBHOOK_SECRET) {
    if (ALLOW_INSECURE_OPEN_API) {
      console.warn('[SECURITY WARNING] WEBHOOK_SECRET not set AND ALLOW_INSECURE_OPEN_API=true — ingest/agent-completion webhook HMAC is DISABLED.');
    } else {
      console.error('[SECURITY ERROR] WEBHOOK_SECRET not set — ingest + agent-completion webhooks will be REJECTED (fail-closed). Set WEBHOOK_SECRET in production, or set ALLOW_INSECURE_OPEN_API=true to restore the legacy open behavior (NOT recommended).');
    }
  }
  if (!REQUIRE_CF_ACCESS) {
    console.warn('[SECURITY WARNING] REQUIRE_CF_ACCESS not set, Cloudflare Access enforcement is OFF. Set REQUIRE_CF_ACCESS=true in production.');
  }
}

function isSameOriginRequest(request: NextRequest): boolean {
  const host = request.headers.get('host');
  if (!host) return false;

  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');

  if (!origin && !referer) return false;

  if (origin) {
    try {
      if (new URL(origin).host === host) return true;
    } catch {
      // ignore invalid origin
    }
  }

  if (referer) {
    try {
      if (new URL(referer).host === host) return true;
    } catch {
      // ignore invalid referer
    }
  }

  return false;
}

function unauthorized(message: string, status = 401): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Cloudflare health checks + liveness/deep probes must bypass everything.
  // NOTE: this is a SUBTREE match (`/api/health`, `/api/health/`,
  // `/api/health/deep`, …) — the CI thin-probe and CF health checks hit
  // `/api/health/deep`, which must stay reachable with no MC_API_TOKEN set.
  if (matchesRoute(pathname, '/api/health')) {
    return NextResponse.next();
  }

  // Demo mode, read-only public deployment.
  if (DEMO_MODE) {
    if (pathname.startsWith('/api/')) {
      const method = request.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        return NextResponse.json(
          { error: 'Demo mode, this is a read-only instance.' },
          { status: 403 }
        );
      }
    }
    const response = NextResponse.next();
    response.headers.set('X-Demo-Mode', 'true');
    return response;
  }

  // Layer 1: Cloudflare Access.
  // When REQUIRE_CF_ACCESS is on, every non-health route must carry the CF
  // Access headers. Cloudflare populates these on its edge. Absence means
  // either the request bypassed Cloudflare or Access is not configured on
  // the subdomain.
  const cfJwt = request.headers.get('cf-access-jwt-assertion');
  const cfEmail = request.headers.get('cf-access-authenticated-user-email');
  if (cfJwt) recordCfAccessSeen(cfEmail);

  if (REQUIRE_CF_ACCESS) {
    if (!cfJwt || !cfEmail) {
      return unauthorized(
        'This deployment is misconfigured. Cloudflare Access is not active on this subdomain. Contact the operator.'
      );
    }
  }

  // Layer 2: MC_API_TOKEN for /api/* external callers.
  if (pathname.startsWith('/api/')) {
    // Gate A — webhook routes require WEBHOOK_SECRET to exist at all. Without
    // it the route-level HMAC check authenticates nothing, so the route is an
    // open write surface. Fail closed (503) unless explicitly overridden.
    if (
      !WEBHOOK_SECRET &&
      !ALLOW_INSECURE_OPEN_API &&
      WEBHOOK_SECRET_ROUTES.some((r) => matchesRoute(pathname, r))
    ) {
      return unauthorized(
        'This deployment is misconfigured: WEBHOOK_SECRET is not set, so webhook authentication is disabled. Set WEBHOOK_SECRET (or ALLOW_INSECURE_OPEN_API=true to override). Contact the operator.',
        503
      );
    }

    // Same-origin browser requests are already gated by CF Access (layer 1)
    // so they don't need the bearer token. Checked BEFORE the MC_API_TOKEN
    // gate so the operator UI keeps working whether or not the token is set.
    if (isSameOriginRequest(request)) {
      const passthrough = NextResponse.next();
      if (cfEmail) passthrough.headers.set('x-operator-email', cfEmail);
      return passthrough;
    }

    // Gate B — MC_API_TOKEN must exist to authenticate EXTERNAL /api/* callers.
    // Legacy behavior silently passed everything through when the token was
    // unset; that is the open-default vulnerability (G15-AUTH-HARDEN). Fail
    // closed (503) unless the operator explicitly opted into the open mode.
    if (!MC_API_TOKEN) {
      if (ALLOW_INSECURE_OPEN_API) {
        const passthrough = NextResponse.next();
        if (cfEmail) passthrough.headers.set('x-operator-email', cfEmail);
        return passthrough;
      }
      return unauthorized(
        'This deployment is misconfigured: MC_API_TOKEN is not set, so external API authentication is disabled. Set MC_API_TOKEN (or ALLOW_INSECURE_OPEN_API=true to override). Contact the operator.',
        503
      );
    }

    // Special case: /api/events/stream (SSE) accepts the token as a query
    // param because EventSource cannot set custom headers.
    if (pathname === '/api/events/stream') {
      const queryToken = request.nextUrl.searchParams.get('token');
      if (queryToken && queryToken === MC_API_TOKEN) {
        return NextResponse.next();
      }
    }

    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return unauthorized('Unauthorized');
    }
    const token = authHeader.substring(7);
    if (token !== MC_API_TOKEN) {
      return unauthorized('Unauthorized');
    }

    const passthrough = NextResponse.next();
    if (cfEmail) passthrough.headers.set('x-operator-email', cfEmail);
    return passthrough;
  }

  // Non-API path. CF Access already enforced above (or not required).
  const response = NextResponse.next();
  if (cfEmail) response.headers.set('x-operator-email', cfEmail);
  return response;
}

/**
 * Matcher: every route except Next.js internals, static assets, and
 * favicon. `/api/health` is bypassed inside the middleware body so it stays
 * matched (we want this code to run, just to early-return for it).
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|public/).*)',
  ],
};
