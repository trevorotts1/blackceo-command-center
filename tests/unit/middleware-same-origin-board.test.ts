/**
 * Middleware auth matrix — board same-origin reads vs external/ingest auth.
 *
 * Regression guard for the v4.72.0 board-blank fix. v4.71.0's middleware
 * (src/middleware.ts) blanked the Command Center board on any box NOT fronted by
 * Cloudflare Access, because:
 *   1. REQUIRE_CF_ACCESS defaulted ON in production (Layer 1 401s every route
 *      when the CF edge injects no `cf-access-jwt-assertion`), and
 *   2. the same-origin passthrough was hardened to require `cfJwt && cfEmail`, so
 *      the board's tokenless same-origin /api reads fell through to the bearer
 *      gate and returned 401.
 *
 * This suite proves BOTH halves of the fix at once:
 *   • SAME-ORIGIN board READ/WRITE APIs pass through (200) on a plain-tunnel box
 *     with NO CF assertion and NO bearer — the board renders.
 *   • EXTERNAL / cross-origin / ingest / webhook paths STILL require their
 *     MC_API_TOKEN bearer + WEBHOOK_SECRET HMAC gate — no security regression.
 *   • REQUIRE_CF_ACCESS remains a working opt-in for CF-Access-fronted boxes.
 *
 * The middleware reads its env into module-level constants at import time, so
 * each scenario sets process.env then re-imports the module with a fresh registry
 * (vi.resetModules + dynamic import).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { AUTH_REJECTED_PATH } from '@/lib/probes/unauthorized-401-contract';
import { CSRF_COOKIE_NAME } from '@/lib/csrf-protection';

const BOARD_HOST = 'board.example.com';
const BOARD_ORIGIN = `https://${BOARD_HOST}`;

// The exact READ endpoints named in the bug report (the board's own data reads).
const BOARD_READ_APIS = [
  '/api/tasks',
  '/api/workspaces',
  '/api/departments',
  '/api/company-health',
  '/api/persona-matrix',
  '/api/org-chart',
];

// The EXTERNAL write/ingest surface the security train closed (DATA-09/10/11).
// These must NEVER be reachable via the same-origin passthrough.
const INGEST_WEBHOOK_APIS = [
  '/api/tasks/ingest',
  '/api/webhooks/agent-completion',
  '/api/webhooks/auto-route',
  '/api/webhooks/task-created',
  '/api/tasks/abc123/status', // dynamic Skill-6 status consumer
];

const ENV_KEYS = [
  'NODE_ENV',
  'MC_API_TOKEN',
  'WEBHOOK_SECRET',
  'REQUIRE_CF_ACCESS',
  'ALLOW_INSECURE_OPEN_API',
  'DEMO_MODE',
] as const;

type EnvOverrides = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.resetModules();
});

type Middleware = (req: NextRequest) => Promise<NextResponse>;

async function loadMiddleware(env: EnvOverrides): Promise<Middleware> {
  for (const k of ENV_KEYS) {
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const mod = await import('@/middleware');
  return mod.middleware as Middleware;
}

interface ReqOpts {
  method?: string;
  sameOrigin?: boolean; // sets a same-origin Referer (the board's own fetch)
  origin?: string; // a raw cross-origin Origin header
  bearer?: string; // Authorization: Bearer <bearer>
  cf?: boolean; // simulate a verified Cloudflare Access assertion
  csrf?: string; // MR-23: signed CSRF cookie value for mutating same-origin requests
}

function makeReq(path: string, opts: ReqOpts = {}): NextRequest {
  const headers: Record<string, string> = { host: BOARD_HOST };
  if (opts.sameOrigin) headers['referer'] = `${BOARD_ORIGIN}/`;
  if (opts.origin) headers['origin'] = opts.origin;
  if (opts.bearer) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.cf) {
    headers['cf-access-jwt-assertion'] = 'edge-verified-jwt';
    headers['cf-access-authenticated-user-email'] = 'operator@example.com';
  }
  if (opts.csrf) headers['cookie'] = `${CSRF_COOKIE_NAME}=${opts.csrf}`;
  return new NextRequest(`${BOARD_ORIGIN}${path}`, {
    method: opts.method ?? 'GET',
    headers,
  });
}

/** NextResponse.next() → status 200 + x-middleware-next:"1". Errors have neither. */
function isPassthrough(res: NextResponse): boolean {
  return res.status === 200 && res.headers.get('x-middleware-next') === '1';
}

/**
 * Post-AUD-71 (FLEET-FIX 2.3) spelling of "the middleware rejected this caller
 * for bad/missing credentials."
 *
 * A CREDENTIAL-FAILURE 401 (missing Authorization header / wrong bearer) is no
 * longer a direct `NextResponse.json({error},{status:401})` from the middleware.
 * The middleware runs in the EDGE runtime and the 401 counter must be readable
 * from a NODE health route, so the middleware `NextResponse.rewrite()`s the
 * rejected request to the internal Node sink (`AUTH_REJECTED_PATH`), which
 * returns the real `401 {"error":"Unauthorized"}` body AND records the
 * telemetry. The middleware's OWN return is therefore a rewrite (HTTP 200 +
 * `x-middleware-rewrite` -> the sink), not a raw 401 — but it is still a
 * REFUSAL: the caller never reaches the protected route.
 *
 * The end-to-end 401 the caller actually receives is proven separately
 * (tests/e2e/prove-401-telemetry.e2e.mjs, against a real next build). Here we
 * assert the middleware's ROUTING DECISION, which is this suite's concern:
 * refused, and specifically routed to the 401 sink (never smuggled through to
 * the real route). MISCONFIGURATION refusals (503, and the CF-Access-not-active
 * 401) are still DIRECT responses and keep their raw-status assertions below —
 * they are not credential failures and are not rewritten.
 */
function isCredentialRejection(res: NextResponse): boolean {
  if (isPassthrough(res)) return false;
  const rewrite = res.headers.get('x-middleware-rewrite');
  if (!rewrite) return false;
  try {
    return new URL(rewrite, BOARD_ORIGIN).pathname === AUTH_REJECTED_PATH;
  } catch {
    return rewrite.includes(AUTH_REJECTED_PATH);
  }
}

// Real deploy: `next start` forces production. Prove the fix in production mode.
const TOKEN = 'mc-token-value';
const SECRET = 'webhook-secret-value';

describe('plain Cloudflare Tunnel box (no CF Access), secrets provisioned, production', () => {
  const ENV: EnvOverrides = {
    NODE_ENV: 'production',
    MC_API_TOKEN: TOKEN,
    WEBHOOK_SECRET: SECRET,
    REQUIRE_CF_ACCESS: undefined, // default OFF (opt-in) after the fix
    ALLOW_INSECURE_OPEN_API: undefined,
    DEMO_MODE: undefined,
  };

  it.each(BOARD_READ_APIS)(
    'THE FIX: same-origin board read %s returns 200 with NO CF assertion and NO bearer',
    async (path) => {
      const mw = await loadMiddleware(ENV);
      const res = await mw(makeReq(path, { sameOrigin: true }));
      expect(res.status).toBe(200);
      expect(isPassthrough(res)).toBe(true);
    },
  );

  // MR-23: same-origin mutating requests now require a signed CSRF cookie.
  // The middleware still passes them through — but only when the browser has the
  // cookie (which is set by the middleware on every non-API page response).

  it('same-origin board WRITE (DELETE /api/tasks/:id) passes through with a valid CSRF cookie (MR-23)', async () => {
    const mw = await loadMiddleware(ENV);
    // Dynamically import the sign function to mint a valid token under the same env.
    const { signCsrfToken } = await import('@/lib/csrf-protection');
    const { value: csrfValue } = await signCsrfToken();
    const res = await mw(makeReq('/api/tasks/abc123', { method: 'DELETE', sameOrigin: true, csrf: csrfValue }));
    expect(isPassthrough(res)).toBe(true);
  });

  it('same-origin board WRITE (POST /api/workspaces) passes through with a valid CSRF cookie (MR-23)', async () => {
    const mw = await loadMiddleware(ENV);
    const { signCsrfToken } = await import('@/lib/csrf-protection');
    const { value: csrfValue } = await signCsrfToken();
    const res = await mw(makeReq('/api/workspaces', { method: 'POST', sameOrigin: true, csrf: csrfValue }));
    expect(isPassthrough(res)).toBe(true);
  });

  it('MR-23: same-origin board WRITE WITHOUT a CSRF cookie is rejected', async () => {
    const mw = await loadMiddleware(ENV);
    const res = await mw(makeReq('/api/tasks/abc123', { method: 'DELETE', sameOrigin: true }));
    // Without the signed CSRF cookie the mutating same-origin request is
    // refused. This is a misconfiguration/forgery signal, not a credential
    // failure — it returns a direct 401, not a rewrite to the 401 sink.
    expect(isPassthrough(res)).toBe(false);
    expect(res.status).toBe(401);
  });

  it('external cross-origin read WITHOUT bearer is rejected (401)', async () => {
    const mw = await loadMiddleware(ENV);
    const res = await mw(makeReq('/api/tasks', { origin: 'https://evil.example.com' }));
    // AUD-71: credential-failure 401 is now delivered via a rewrite to the 401
    // sink (see isCredentialRejection). Still a refusal; never a passthrough.
    expect(isCredentialRejection(res)).toBe(true);
    expect(isPassthrough(res)).toBe(false);
  });

  it('external read WITH a valid bearer passes through (bearer path intact)', async () => {
    const mw = await loadMiddleware(ENV);
    const res = await mw(makeReq('/api/tasks', { bearer: TOKEN }));
    expect(isPassthrough(res)).toBe(true);
  });

  it('external read with a WRONG bearer is rejected (401)', async () => {
    const mw = await loadMiddleware(ENV);
    const res = await mw(makeReq('/api/tasks', { bearer: 'not-the-token' }));
    // AUD-71: token-mismatch is a credential failure -> rewrite to the 401 sink.
    expect(isCredentialRejection(res)).toBe(true);
  });

  it.each(INGEST_WEBHOOK_APIS)(
    'NO REGRESSION: ingest/webhook %s from a FORGED same-origin caller (no bearer) is rejected (401)',
    async (path) => {
      const mw = await loadMiddleware(ENV);
      // Forge a same-origin Referer to try to skip the bearer gate — must fail.
      const res = await mw(makeReq(path, { method: 'POST', sameOrigin: true }));
      // The security property this guards is UNCHANGED: a webhook/ingest route is
      // never reachable via the same-origin passthrough, so a bearer-less forged
      // caller is refused. AUD-71 only changes HOW the refusal is delivered
      // (rewrite to the 401 sink), not WHETHER it happens — isPassthrough stays
      // false, proving no smuggling to the real route.
      expect(isCredentialRejection(res)).toBe(true);
      expect(isPassthrough(res)).toBe(false);
    },
  );

  it('ingest WITH a valid bearer passes the middleware layer (route HMAC still applies downstream)', async () => {
    const mw = await loadMiddleware(ENV);
    const res = await mw(makeReq('/api/tasks/ingest', { method: 'POST', sameOrigin: true, bearer: TOKEN }));
    expect(isPassthrough(res)).toBe(true);
  });
});

describe('unprovisioned box (no MC_API_TOKEN / WEBHOOK_SECRET), production — fail-closed for external, board still renders', () => {
  const ENV: EnvOverrides = {
    NODE_ENV: 'production',
    MC_API_TOKEN: undefined,
    WEBHOOK_SECRET: undefined,
    REQUIRE_CF_ACCESS: undefined,
    ALLOW_INSECURE_OPEN_API: undefined,
    DEMO_MODE: undefined,
  };

  it('same-origin board read still passes through even with NO secrets set', async () => {
    const mw = await loadMiddleware(ENV);
    const res = await mw(makeReq('/api/tasks', { sameOrigin: true }));
    expect(isPassthrough(res)).toBe(true);
  });

  it('external read is fail-closed (503) when MC_API_TOKEN is unset', async () => {
    const mw = await loadMiddleware(ENV);
    const res = await mw(makeReq('/api/tasks', { origin: 'https://evil.example.com' }));
    expect(res.status).toBe(503);
  });

  it('ingest is fail-closed (503) when WEBHOOK_SECRET is unset (even same-origin)', async () => {
    const mw = await loadMiddleware(ENV);
    const res = await mw(makeReq('/api/tasks/ingest', { method: 'POST', sameOrigin: true }));
    expect(res.status).toBe(503);
  });
});

describe('CF-Access-fronted box (opt-in REQUIRE_CF_ACCESS=true still enforces)', () => {
  const ENV: EnvOverrides = {
    NODE_ENV: 'production',
    MC_API_TOKEN: TOKEN,
    WEBHOOK_SECRET: SECRET,
    REQUIRE_CF_ACCESS: 'true',
    ALLOW_INSECURE_OPEN_API: undefined,
    DEMO_MODE: undefined,
  };

  it('request WITHOUT a CF assertion is rejected at Layer 1 (401)', async () => {
    const mw = await loadMiddleware(ENV);
    const res = await mw(makeReq('/api/tasks', { sameOrigin: true }));
    expect(res.status).toBe(401);
  });

  it('CF-verified same-origin board read passes through (200)', async () => {
    const mw = await loadMiddleware(ENV);
    const res = await mw(makeReq('/api/tasks', { sameOrigin: true, cf: true }));
    expect(isPassthrough(res)).toBe(true);
  });

  it('ingest WITH a CF assertion but NO bearer is still rejected (401) — bearer required behind CF', async () => {
    const mw = await loadMiddleware(ENV);
    const res = await mw(makeReq('/api/tasks/ingest', { method: 'POST', sameOrigin: true, cf: true }));
    // Passes CF Layer 1 but has no bearer -> credential failure -> rewrite to the
    // 401 sink (AUD-71). The bearer-required-behind-CF property is intact.
    expect(isCredentialRejection(res)).toBe(true);
  });
});

/**
 * MR-23 security-posture regression guard.
 *
 * The signed CSRF cookie closes CROSS-SITE forgery (SameSite=Strict) and
 * UNSIGNED double-submit forgery (HMAC). It does NOT close the DIRECT-to-origin
 * forgery the finding names, because the token is minted on unauthenticated
 * public page loads and can be harvested + replayed. These tests pin that truth
 * so a future change cannot silently regress either way:
 *   • harvest-and-replay still passes on a plain-tunnel box (residual OPEN), and
 *   • REQUIRE_CF_ACCESS=true closes it at Layer 1 (residual CLOSED).
 */
describe('MR-23 direct-to-origin forgery — true security posture', () => {
  const ENV: EnvOverrides = {
    NODE_ENV: 'production',
    MC_API_TOKEN: TOKEN,
    WEBHOOK_SECRET: SECRET,
    REQUIRE_CF_ACCESS: undefined,
    ALLOW_INSECURE_OPEN_API: undefined,
    DEMO_MODE: undefined,
  };

  /** Harvest a valid CSRF cookie the way a direct-to-origin caller would: load a
   *  gate-exempt public page with no auth and read the Set-Cookie. */
  async function harvestCsrfCookie(mw: Middleware): Promise<string | undefined> {
    const pageRes = await mw(
      new NextRequest(`${BOARD_ORIGIN}/interview`, { method: 'GET', headers: { host: BOARD_HOST } }),
    );
    const setCookie = pageRes.headers.get('set-cookie') ?? '';
    return setCookie.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`))?.[1];
  }

  it('a direct caller harvests a valid CSRF cookie from an unauthenticated public page', async () => {
    const mw = await loadMiddleware(ENV);
    const token = await harvestCsrfCookie(mw);
    expect(token).toBeTruthy();
  });

  it('RESIDUAL OPEN on plain tunnel: harvested cookie + forged same-origin header reaches a mutating route (no bearer, no CF)', async () => {
    const mw = await loadMiddleware(ENV);
    const token = await harvestCsrfCookie(mw);
    expect(token).toBeTruthy();
    const attack = new NextRequest(`${BOARD_ORIGIN}/api/tasks/abc123`, {
      method: 'DELETE',
      headers: {
        host: BOARD_HOST,
        referer: `${BOARD_ORIGIN}/`, // forged same-origin
        cookie: `${CSRF_COOKIE_NAME}=${token}`,
      },
    });
    // Documents (does not endorse) that the direct-forgery residual persists
    // without CF Access. The signed cookie cannot defeat harvest-and-replay.
    expect(isPassthrough(await mw(attack))).toBe(true);
  });

  it('RESIDUAL CLOSED by REQUIRE_CF_ACCESS=true: the same harvest-and-replay is rejected at Layer 1', async () => {
    const cfEnv: EnvOverrides = { ...ENV, REQUIRE_CF_ACCESS: 'true' };
    const mw = await loadMiddleware(cfEnv);
    const token = await harvestCsrfCookie(mw); // page load is also rejected under CF
    const attack = new NextRequest(`${BOARD_ORIGIN}/api/tasks/abc123`, {
      method: 'DELETE',
      headers: {
        host: BOARD_HOST,
        referer: `${BOARD_ORIGIN}/`,
        ...(token ? { cookie: `${CSRF_COOKIE_NAME}=${token}` } : {}),
      },
    });
    const res = await mw(attack);
    // No CF-Access assertion -> Layer 1 misconfiguration 401, before passthrough.
    expect(isPassthrough(res)).toBe(false);
    expect(res.status).toBe(401);
  });
});

