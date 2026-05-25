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
 * Local dev (no Cloudflare in front, no MC_API_TOKEN set) is fully open with
 * a startup warning so the operator notices.
 *
 * Production misconfiguration (Cloudflare Access not enabled on the
 * subdomain) returns 401 with a clear error message so the operator knows
 * exactly what to fix.
 */

const MC_API_TOKEN = process.env.MC_API_TOKEN;
const REQUIRE_CF_ACCESS = process.env.REQUIRE_CF_ACCESS === 'true';
const DEMO_MODE = process.env.DEMO_MODE === 'true';

if (!MC_API_TOKEN && !DEMO_MODE) {
  console.warn('[SECURITY WARNING] MC_API_TOKEN not set, external API auth is DISABLED (local dev mode)');
}
if (!REQUIRE_CF_ACCESS && !DEMO_MODE) {
  console.warn('[SECURITY WARNING] REQUIRE_CF_ACCESS not set, Cloudflare Access enforcement is OFF (local dev mode). Set REQUIRE_CF_ACCESS=true in production.');
}
if (DEMO_MODE) {
  console.log('[DEMO] Running in demo mode, all write operations are blocked');
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

  // Cloudflare health checks must bypass everything.
  if (pathname === '/api/health' || pathname === '/api/health/') {
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
    // If MC_API_TOKEN is not configured, skip API token enforcement (dev mode).
    if (!MC_API_TOKEN) {
      const passthrough = NextResponse.next();
      if (cfEmail) passthrough.headers.set('x-operator-email', cfEmail);
      return passthrough;
    }

    // Same-origin browser requests are already gated by CF Access (layer 1)
    // so they don't need the bearer token.
    if (isSameOriginRequest(request)) {
      const passthrough = NextResponse.next();
      if (cfEmail) passthrough.headers.set('x-operator-email', cfEmail);
      return passthrough;
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
