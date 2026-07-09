import { NextRequest, NextResponse } from 'next/server';
import { recordCfAccessSeen } from '@/lib/probes/cloudflare-access-probe';
import { INTERVIEW_COOKIE_NAME, verifyInterviewToken } from '@/lib/interview/gate-cookie';

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
 *   - `/participant` (the Anthology participant token page, SPEC 11.3) bypasses
 *     both layers exactly the way `/api/health` does. External co-author
 *     participants have NO Cloudflare Access login and NO MC_API_TOKEN; the page
 *     authenticates each visitor entirely on its own via a single-purpose scoped
 *     token/PIN the engine mints (HMAC over participant_key + gate id + expiry
 *     under ANTHOLOGY_GATE_TOKEN_SECRET). An unauthenticated or foreign/expired/
 *     replayed visitor is refused by the page, never by the middleware.
 *
 * Fail-closed posture (G15-AUTH-HARDEN):
 *   - When MC_API_TOKEN is unset, EXTERNAL (non-same-origin) /api/* callers
 *     are REJECTED with a 503 misconfiguration error instead of being let
 *     through. Same-origin browser requests still work because Cloudflare
 *     Access (layer 1) gates them.
 *   - The webhook routes in WEBHOOK_SECRET_ROUTES (ingest, agent-completion,
 *     and the Skill-6 per-task status consumer /api/tasks/[id]/status) are
 *     REJECTED with a 503 when WEBHOOK_SECRET is unset, because their
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
/**
 * Cloudflare Access enforcement (DATA-10).
 *
 * Now DEFAULT-ON in production images: a prod box must explicitly opt out with
 * REQUIRE_CF_ACCESS=false (documented, discouraged). Anywhere else (dev/test)
 * keeps the historical default-OFF so local runs aren't forced through the CF
 * edge. This is the belt to the same-origin-passthrough gate below — forgeable
 * `Origin`/`Referer` headers are only ever trusted when a VERIFIED CF-Access
 * assertion is present, and in production CF Access is now required by default
 * so that assertion is actually enforced at the edge.
 *
 * NOTE (live-box, §7 #2): whether Cloudflare Access is truly enabled on each of
 * the ~32 client subdomains is an operator/deploy concern this flag cannot
 * verify from inside the app. Default-ON only makes the app REQUIRE the CF
 * headers; the operator must confirm the edge actually injects them.
 */
const REQUIRE_CF_ACCESS =
  process.env.NODE_ENV === 'production'
    ? process.env.REQUIRE_CF_ACCESS !== 'false'
    : process.env.REQUIRE_CF_ACCESS === 'true';
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
 *
 * INGEST-05 — NEUTERED IN PRODUCTION. The escape hatch was previously honored
 * regardless of NODE_ENV: the documented posture was "production never sets
 * it," but nothing in code enforced that, so a stray/inherited/mis-scoped
 * ALLOW_INSECURE_OPEN_API=true reaching a production box (bad env template,
 * copy-pasted CI/test env, compromised env store) would silently disable both
 * the MC_API_TOKEN bearer gate and the WEBHOOK_SECRET HMAC gate in prod — the
 * exact open-ingest/open-completion hole DATA-09/DATA-10 close. The flag is
 * now hard-gated on NODE_ENV !== 'production' at this single source of truth,
 * so every downstream check below (which already reads this constant) is
 * neutered in prod even if the operator/deploy env sets the var. Test/dev
 * runs are unaffected: the e2e (tests/e2e/duck-test.ts) and smoke-test
 * (scripts/smoke-test-converge-and-dept.ts) harnesses that rely on this
 * bridge run with NODE_ENV 'test' / unset, never 'production'.
 */
const ALLOW_INSECURE_OPEN_API =
  process.env.NODE_ENV !== 'production' && process.env.ALLOW_INSECURE_OPEN_API === 'true';

/**
 * Routes that accept EXTERNAL (non-Cloudflare-Access) webhook callers and
 * authenticate purely via HMAC-SHA256 over WEBHOOK_SECRET. If the secret is
 * absent the route-level HMAC check authenticates nothing, so these routes
 * must be refused at the gate unless the operator has opted into open mode.
 */
const WEBHOOK_SECRET_ROUTES = [
  '/api/tasks/ingest',
  '/api/webhooks/agent-completion',
  // DATA-09: auto-route + task-created mutate routing/dispatch and previously
  // had NO route-level auth. They now self-authenticate with the same Bearer
  // (middleware) + HMAC-over-WEBHOOK_SECRET (route) scheme as agent-completion,
  // so they join the fail-closed family: a box without WEBHOOK_SECRET refuses
  // them at the gate (503) instead of leaving an open write surface.
  '/api/webhooks/auto-route',
  '/api/webhooks/task-created',
];

/**
 * Same family as WEBHOOK_SECRET_ROUTES, but for routes with a dynamic `[id]`
 * segment in the middle of the path (e.g. `/api/tasks/{id}/status`, the
 * Skill-6 status-transition consumer route). `matchesRoute`'s prefix match
 * can't express "one dynamic segment then a fixed suffix", so those routes
 * get a regex matcher instead. Keep in sync with the route's own auth
 * comment (src/app/api/tasks/[id]/status/route.ts) — it self-authenticates
 * with the identical Bearer + HMAC scheme, so it belongs in the same
 * fail-closed family as the static WEBHOOK_SECRET_ROUTES entries.
 */
const WEBHOOK_SECRET_DYNAMIC_ROUTES: RegExp[] = [
  /^\/api\/tasks\/[^/]+\/status$/, // /api/tasks/{id}/status
];

/**
 * The Anthology participant token page (SPEC 11.3). This is the ONLY public,
 * unauthenticated page surface in the deployment: external co-author
 * participants who have no Cloudflare Access account approve their own gate
 * (title selection, outline approval, chapter approve-or-rewrite) via a scoped
 * token/PIN. It is a SUBTREE match so `/participant`, `/participant/`, and
 * `/participant/<token>` all bypass. Registered in BOTH the early-return bypass
 * below AND `isInterviewGateExempt` so the interview shell-lock 302 can never
 * swallow it (belt-and-suspenders: the early return alone already exempts it,
 * but the shell-lock exemption is kept explicit so a future re-order of the
 * middleware body cannot silently trap participants behind /interview).
 */
const PARTICIPANT_PUBLIC_ROUTE = '/participant';

function matchesRoute(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

function isWebhookSecretRoute(pathname: string): boolean {
  return (
    WEBHOOK_SECRET_ROUTES.some((r) => matchesRoute(pathname, r)) ||
    WEBHOOK_SECRET_DYNAMIC_ROUTES.some((r) => r.test(pathname))
  );
}

/**
 * Routes exempt from the interview-mode shell lock (P0-5 / WG-9). While the
 * interview is incomplete the middleware 302s every OTHER page route to
 * /interview, so the client only ever sees the interview until closeout.
 * Exempt:
 *   • /interview(/*)            — the lock target itself (no redirect loop)
 *   • /onboarding(/*)           — resume redirect (P0-7) + /onboarding/building
 *   • /api/*                    — never lock an API route (also returned earlier)
 *   • /_next/*                  — framework internals + RSC/data payloads
 *   • asset-like requests       — anything whose last path segment has a dot
 *                                 (favicon.ico, robots.txt, *.svg, manifest.json…)
 */
function isInterviewGateExempt(pathname: string): boolean {
  if (pathname === '/interview' || pathname.startsWith('/interview/')) return true;
  if (pathname === '/onboarding' || pathname.startsWith('/onboarding/')) return true;
  // The Anthology participant token page is a public, self-authenticating
  // surface for external co-authors (SPEC 11.3) — it must never be redirected
  // to the operator interview shell.
  if (matchesRoute(pathname, PARTICIPANT_PUBLIC_ROUTE)) return true;
  if (pathname.startsWith('/api/')) return true;
  if (pathname.startsWith('/_next/')) return true;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (last.includes('.')) return true;
  return false;
}

if (DEMO_MODE) {
  console.log('[DEMO] Running in demo mode, all write operations are blocked');
} else {
  // INGEST-05: flag it loudly when the raw env var is set but NODE_ENV=production
  // neutered it, so an operator debugging "why is ALLOW_INSECURE_OPEN_API=true not
  // working" gets a direct answer instead of silently-still-fail-closed confusion.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_INSECURE_OPEN_API === 'true') {
    console.error('[SECURITY] ALLOW_INSECURE_OPEN_API=true is set but NEUTERED in production (INGEST-05) — this escape hatch only works outside production. Fail-closed auth (MC_API_TOKEN / WEBHOOK_SECRET) remains fully enforced. Remove this var from the production env; it is a test/dev-only bridge.');
  }
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
    if (process.env.NODE_ENV === 'production') {
      // DATA-10: default is ON in prod, so reaching here means an explicit opt-out.
      console.error('[SECURITY ERROR] REQUIRE_CF_ACCESS=false in production — Cloudflare Access enforcement is DISABLED. Same-origin passthrough is only honored behind a verified CF-Access assertion (DATA-10), so with CF Access off, external /api/* callers must present the MC_API_TOKEN bearer. Remove REQUIRE_CF_ACCESS=false to restore the default-on posture.');
    } else {
      console.warn('[SECURITY WARNING] Cloudflare Access enforcement is OFF (non-production default). It defaults ON in production images; set REQUIRE_CF_ACCESS=true here only if you want to exercise the CF path locally.');
    }
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

/**
 * Constant-time string comparison (DATA-11).
 *
 * `===` on a secret short-circuits on the first differing byte, leaking
 * length/prefix information through response timing. Used for every comparison
 * against MC_API_TOKEN — including the `/api/events/stream` query-param token,
 * which is the highest-exposure surface because the token travels in the URL
 * (and thus into access logs / Referer). This runs in the Edge runtime, where
 * node:crypto's timingSafeEqual is unavailable, so we fold over the max length
 * (never early-returning on a length mismatch) using the Web-standard
 * TextEncoder.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Cloudflare health checks + liveness/deep probes must bypass everything.
  // NOTE: this is a SUBTREE match (`/api/health`, `/api/health/`,
  // `/api/health/deep`, …) — the CI thin-probe and CF health checks hit
  // `/api/health/deep`, which must stay reachable with no MC_API_TOKEN set.
  if (matchesRoute(pathname, '/api/health')) {
    return NextResponse.next();
  }

  // Anthology participant token page (SPEC 11.3) — the ONE public,
  // self-authenticating page surface. Bypasses every auth layer exactly the
  // way `/api/health` does: the page verifies the visitor's scoped token/PIN
  // itself (engine gate_engine.py, HMAC under ANTHOLOGY_GATE_TOKEN_SECRET) and
  // refuses foreign/expired/replayed access, so no CF Access / MC_API_TOKEN /
  // interview-shell gate applies. SUBTREE match (see PARTICIPANT_PUBLIC_ROUTE).
  if (matchesRoute(pathname, PARTICIPANT_PUBLIC_ROUTE)) {
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
      isWebhookSecretRoute(pathname)
    ) {
      return unauthorized(
        'This deployment is misconfigured: WEBHOOK_SECRET is not set, so webhook authentication is disabled. Set WEBHOOK_SECRET (or ALLOW_INSECURE_OPEN_API=true to override). Contact the operator.',
        503
      );
    }

    // Same-origin browser requests are gated by Cloudflare Access (layer 1) and
    // so don't need the bearer token — BUT only when CF Access has actually
    // verified the request. `Origin` and `Referer` are client-controllable
    // headers: an external caller reaching the origin directly can forge a
    // same-origin `Referer`/`Origin` to skip the MC_API_TOKEN bearer gate
    // (DATA-10 — the umbrella that also exposed the unauthenticated write paths
    // in other lanes). We therefore honor the same-origin passthrough ONLY when
    // a VERIFIED CF-Access assertion is present: both `cf-access-jwt-assertion`
    // and `cf-access-authenticated-user-email` are populated by Cloudflare's
    // edge and cannot be set by a client that bypasses Cloudflare. Without that
    // assertion the request falls through to the MC_API_TOKEN bearer check
    // below, so a forged same-origin header is worthless on its own.
    if (cfJwt && cfEmail && isSameOriginRequest(request)) {
      const passthrough = NextResponse.next();
      passthrough.headers.set('x-operator-email', cfEmail);
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
    // param because EventSource cannot set custom headers. Compared in constant
    // time (DATA-11). RESIDUAL (cross-lane / operator): passing the long-lived
    // MASTER token in a URL still lands it in access logs and Referer headers.
    // The full fix is to mint a short-lived, single-purpose stream token (like
    // the interview cookie HMAC) — that spans the stream route + useSSE client
    // (Wave-2 L12), so it is deferred here; and the master token must be on a
    // mandatory rotation (§7 secret-rotation). This gate is constant-time-hardened
    // in the interim.
    if (pathname === '/api/events/stream') {
      const queryToken = request.nextUrl.searchParams.get('token');
      if (queryToken && timingSafeEqualStr(queryToken, MC_API_TOKEN)) {
        return NextResponse.next();
      }
    }

    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return unauthorized('Unauthorized');
    }
    const token = authHeader.substring(7);
    if (!timingSafeEqualStr(token, MC_API_TOKEN)) {
      return unauthorized('Unauthorized');
    }

    const passthrough = NextResponse.next();
    if (cfEmail) passthrough.headers.set('x-operator-email', cfEmail);
    return passthrough;
  }

  // ── Interview-mode shell lock (P0-5 / WG-9) ─────────────────────────────
  // RATIFIED re-scope of "No CC = interview not done, BY DESIGN": the dashboard
  // stays locked behind /interview until the AI Workforce interview is complete
  // (or the build has finished / closeout), so the client never lands on an
  // empty dashboard — the full CC is the closeout reveal.
  //
  // Edge can't read the DB/state, so a Node setter (the refreshInterviewGate
  // server action mounted by the root layout) maintains a short-TTL signed
  // `mc_interview_complete` cookie; here we only READ + verify it. Only GET/HEAD
  // page navigations are gated (never server-action POSTs). Completion is
  // terminal: a signature-valid "complete" token unlocks even if it has expired
  // (it never reverts; the setter just refreshes it). Every other signal —
  // valid-incomplete, expired-incomplete, absent, or forged — fails CLOSED to
  // /interview (the documented mitigation).
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    !isInterviewGateExempt(pathname)
  ) {
    const token = request.cookies.get(INTERVIEW_COOKIE_NAME)?.value;
    const verdict = await verifyInterviewToken(token);
    if (verdict.complete !== true) {
      const redirect = NextResponse.redirect(new URL('/interview', request.url), 302);
      if (cfEmail) redirect.headers.set('x-operator-email', cfEmail);
      return redirect;
    }
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
