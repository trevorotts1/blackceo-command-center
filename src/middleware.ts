import { NextRequest, NextResponse } from 'next/server';
import { recordCfAccessSeen } from '@/lib/probes/cloudflare-access-probe';
import {
  AUTH_REJECTED_PATH,
  AUTH_REJECT_HEADERS,
  AuthRejectionSignal,
  REWRITABLE_METHODS,
  Unauthorized401Event,
  isCredentialFailure,
  logUnauthorized401,
  sanitizeHeaderValue,
} from '@/lib/probes/unauthorized-401-contract';
import { INTERVIEW_COOKIE_NAME, LATCH_COOKIE_NAME, verifyInterviewToken } from '@/lib/interview/gate-cookie';

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
 *      requests do NOT need the bearer token: the board is served through the
 *      same origin and is trusted by the same-origin passthrough (Layer 2), so
 *      it renders on plain-tunnel boxes as well as CF-Access-fronted ones.
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
 *     through. Same-origin browser requests still work via the same-origin
 *     passthrough below (the board reading its own data).
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
 * Cloudflare Access enforcement (DATA-10) — OPT-IN (default OFF on ALL boxes).
 *
 * v4.72.0 (board-blank fix). v4.71.0 made this DEFAULT-ON in production so the
 * same-origin passthrough below could trust a VERIFIED CF-Access assertion. But
 * default-ON hard-401s EVERY non-health route — the board page shell AND every
 * /api read it makes — on any box the operator did NOT front with Cloudflare
 * Access, i.e. a plain Cloudflare Tunnel box where the CF edge never injects
 * `cf-access-jwt-assertion`. The fleet does not guarantee CF Access on every one
 * of the ~32 client subdomains (§7 #2: the app cannot verify the edge from
 * inside), so default-ON blanked the Command Center board on those boxes.
 *
 * We restore v4.69.1's opt-in default: enforcement is ON only when an operator
 * who genuinely runs CF Access sets REQUIRE_CF_ACCESS=true (which also closes the
 * same-origin READ residual at the edge for every route). This does NOT weaken
 * external-API security: EXTERNAL /api/* access is always gated by the
 * MC_API_TOKEN bearer (Gate B) and the WEBHOOK_SECRET HMAC (Gate A) below,
 * regardless of REQUIRE_CF_ACCESS. The board renders via the same-origin
 * passthrough, which never needed the CF assertion to serve the board's OWN data.
 */
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
    // v4.72.0: OFF is the documented default (opt-in). The board renders via the
    // same-origin passthrough; EXTERNAL /api/* still requires the MC_API_TOKEN
    // bearer and ingest still requires the WEBHOOK_SECRET HMAC. Set
    // REQUIRE_CF_ACCESS=true only on boxes actually fronted by Cloudflare Access.
    console.warn('[SECURITY] Cloudflare Access enforcement is OFF (opt-in default). External /api/* remains bearer-gated (MC_API_TOKEN) and ingest remains HMAC-gated (WEBHOOK_SECRET). Set REQUIRE_CF_ACCESS=true only on a box actually fronted by Cloudflare Access.');
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

/**
 * Every rejection this middleware emits, telemetry included (FLEET-FIX 2.3 /
 * AUD-71).
 *
 * `signal` — NOT the status code — decides whether a rejection counts as a
 * credential failure. That distinction is load-bearing: the Cloudflare-Access-
 * not-active response below is a MISCONFIGURATION that happens to carry the
 * default 401 status, so a guard written as `if (status === 401)` folds an
 * operator's config fault into the "callers rejected for bad credentials"
 * counter and makes the number lie. Only `missing-header` and `token-mismatch`
 * are credential failures (`isCredentialFailure()`).
 *
 * Delivery: this file runs in the EDGE runtime. It cannot hold a counter the
 * Node health route can read — module state does not cross that boundary. So a
 * credential failure is REWRITTEN to the Node-runtime sink route
 * (`AUTH_REJECTED_PATH`), which increments the authoritative counter, emits the
 * structured log line, and returns the identical `401 {"error":"Unauthorized"}`.
 * A middleware-initiated rewrite is dispatched in-process and does not re-enter
 * middleware. `unauthorized-401-contract.ts` documents the whole boundary.
 *
 * Fallback: Next dispatches a rewrite only for methods the sink route exports
 * (REWRITABLE_METHODS). An exotic verb is answered here directly — same 401,
 * same body, still logged — but with `count: null`, because no counter is
 * reachable from this runtime. Uncounted, never mis-counted.
 */
function unauthorized(
  request: NextRequest,
  message: string,
  signal: AuthRejectionSignal,
  status = 401
): NextResponse {
  if (!isCredentialFailure(signal)) {
    // Misconfiguration (cf-access-misconfigured / mc-api-token-unset /
    // webhook-secret-unset). Never counted, never rewritten.
    return NextResponse.json({ error: message }, { status });
  }

  const event: Unauthorized401Event = {
    pathname: request.nextUrl.pathname,
    method: request.method,
    reason: signal,
    ua: sanitizeHeaderValue(request.headers.get('user-agent')),
    ts: new Date().toISOString(),
  };

  if (REWRITABLE_METHODS.includes(request.method.toUpperCase())) {
    const url = request.nextUrl.clone();
    url.pathname = AUTH_REJECTED_PATH;
    url.search = '';

    // Build the destination's request headers from the caller's, then OVERWRITE
    // every internal field — a client cannot smuggle its own x-cc-auth-reject-*
    // values through (it also cannot reach the route directly; see the 404 guard
    // in middleware()).
    const headers = new Headers(request.headers);
    headers.set(AUTH_REJECT_HEADERS.reason, event.reason);
    headers.set(AUTH_REJECT_HEADERS.pathname, event.pathname);
    headers.set(AUTH_REJECT_HEADERS.method, event.method);
    if (event.ua) headers.set(AUTH_REJECT_HEADERS.ua, event.ua);
    else headers.delete(AUTH_REJECT_HEADERS.ua);

    return NextResponse.rewrite(url, { request: { headers } });
  }

  logUnauthorized401(event, null, 'middleware-direct');
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

  // AUD-71: /api/internal/auth-rejected is this middleware's OWN rewrite target
  // — the Node-runtime sink that owns the 401 counter. It is INTERNAL-ONLY. A
  // direct inbound request must never reach the handler, or an outside caller
  // could inflate the counter and forge the per-reason breakdown by hand-setting
  // the x-cc-auth-reject-* headers. Next does NOT re-run middleware on a
  // middleware-initiated rewrite, so this 404 cannot swallow the internal
  // dispatch (proved end-to-end by tests/e2e/prove-401-telemetry.e2e.mjs, which
  // asserts a rejected caller still receives 401 — not 404 — from a real build).
  if (pathname === AUTH_REJECTED_PATH) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
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
      // MISCONFIGURATION, not a credential failure — and it carries the DEFAULT
      // 401 status, which is exactly why the telemetry guard discriminates on
      // the signal rather than on the status code. This response must never
      // touch the credential-failure counter.
      return unauthorized(
        request,
        'This deployment is misconfigured. Cloudflare Access is not active on this subdomain. Contact the operator.',
        'cf-access-misconfigured'
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
        request,
        'This deployment is misconfigured: WEBHOOK_SECRET is not set, so webhook authentication is disabled. Set WEBHOOK_SECRET (or ALLOW_INSECURE_OPEN_API=true to override). Contact the operator.',
        'webhook-secret-unset',
        503
      );
    }

    // Same-origin passthrough — the board rendering its OWN data (v4.72.0).
    //
    // The Command Center page and every /api read it makes (src/app/page.tsx, the
    // ceo-board, WorkspaceDashboard, …) are served through the SAME tunnel/origin
    // and carry NO bearer token — MC_API_TOKEN is a server-only secret, never
    // exposed to the browser. So a same-origin browser request to a NON-webhook
    // /api/* route is trusted WITHOUT the bearer (restores v4.69.1 behavior). This
    // is what makes the board load its data on EVERY box — a plain Cloudflare
    // Tunnel as well as a CF-Access-fronted subdomain — instead of 401-ing every
    // read. v4.71.0 additionally required a VERIFIED CF-Access assertion here
    // (`cfJwt && cfEmail && …`), which no plain-tunnel box has, so the board
    // blanked (0 tasks / "HTTP 401"). We drop that extra requirement.
    //
    // Scope — do NOT re-open what the train closed. Webhook/ingest routes are
    // EXCLUDED from this passthrough: /api/tasks/ingest, /api/webhooks/*, and
    // /api/tasks/{id}/status are the EXTERNAL write/ingest surface (DATA-09/10/11)
    // and must ALWAYS present the MC_API_TOKEN bearer here (plus their route-level
    // HMAC over WEBHOOK_SECRET), even from a same-origin caller — so a forged
    // same-origin Origin/Referer can never reach them without auth.
    //
    // RESIDUAL (accepted, = v4.69.1): Origin/Referer are client-settable, so a
    // non-browser caller reaching the origin directly can forge a same-origin
    // header to READ the board's own data. That surface is READ-only board data;
    // the ingest/write family above stays fully auth-gated. An operator who fronts
    // the box with Cloudflare Access (REQUIRE_CF_ACCESS=true) closes even this
    // residual at the edge for every route.
    if (!isWebhookSecretRoute(pathname) && isSameOriginRequest(request)) {
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
        request,
        'This deployment is misconfigured: MC_API_TOKEN is not set, so external API authentication is disabled. Set MC_API_TOKEN (or ALLOW_INSECURE_OPEN_API=true to override). Contact the operator.',
        'mc-api-token-unset',
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

    // AUD-71: the two branches below are the CREDENTIAL FAILURES, and they are
    // reported as DISTINCT reasons. Both used to emit the bare literal
    // 'Unauthorized', so an operator staring at a rejected dept-agent write-back
    // could not tell "the caller sent no Authorization header at all" (the agent
    // was never given the token) from "the caller sent the WRONG bearer" (the box
    // has a stale/mismatched MC_API_TOKEN) — two different faults with two
    // different fixes. The discriminated reason rides the telemetry event and the
    // structured log line; the RESPONSE BODY stays the bare 'Unauthorized' on
    // purpose, so the reject reason is never disclosed to the caller.
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return unauthorized(request, 'Unauthorized', 'missing-header');
    }
    const token = authHeader.substring(7);
    if (!timingSafeEqualStr(token, MC_API_TOKEN)) {
      return unauthorized(request, 'Unauthorized', 'token-mismatch');
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
