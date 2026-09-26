import { createHmac } from 'node:crypto';
/**
 * CSF-004 — CSRF token expiring MID-SITTING: rejection + recovery, with negative controls.
 *
 * The CSRF cookie lives 1 hour (CSRF_COOKIE_TTL_SECONDS) and is only re-minted on
 * page load, so an interview sitting longer than that submits its next answer with
 * a properly-signed but PAST-expiry token. This suite proves the failure mode and
 * the self-healing shape at the middleware layer:
 *
 *   1. POSITIVE — a well-formed, genuinely-signed, PAST-exp token on a same-origin
 *      POST /api/interview/answer is rejected (direct 401 `missing-csrf-token`,
 *      NOT a credential-failure sink rewrite), and a FRESH mint on the SAME POST
 *      passes through — the retry path that must never lose the typed answer.
 *   2. NEGATIVE CONTROL — forged signature: well-formed expired payload with a
 *      wrong signature 401s AND the rejection mints NOTHING (no mc_csrf_token in
 *      Set-Cookie). Without this, (1) proves nothing about the narrow mint surface.
 *   3. NEGATIVE CONTROL — absent cookie: no CSRF cookie 401s AND mints NOTHING.
 *
 * NO fake timers: the "expired" token carries a real past `exp` (a full TTL plus
 * slack in the past — a sitting outlasting the 1h cookie life) under a genuinely
 * valid HMAC, so expiry — not clock mocking — is what the middleware rejects.
 * The middleware reads its env into module-level constants at import time, so each
 * scenario sets process.env then re-imports the module with a fresh registry
 * (vi.resetModules + dynamic import), mirroring
 * tests/unit/middleware-same-origin-board.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { AUTH_REJECTED_PATH } from '@/lib/probes/unauthorized-401-contract';
import { CSRF_COOKIE_NAME, CSRF_COOKIE_TTL_SECONDS } from '@/lib/csrf-protection';
import { registerFixtureTenant, fixtureTenantCookie } from './_tenant-auth-fixture';

const BOARD_HOST = 'board.example.com';
const BOARD_ORIGIN = `https://${BOARD_HOST}`;
const ANSWER_PATH = '/api/interview/answer';

const ENV_KEYS = [
  'MC_TENANT_REGISTRY_JSON',
  'MC_TENANT_SESSION_SECRET',
  'MC_INTERVIEW_COOKIE_SECRET',
  'MC_CSRF_COOKIE_SECRET',
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
  registerFixtureTenant(BOARD_HOST);
  vi.resetModules();
  const mod = await import('@/middleware');
  return mod.middleware as Middleware;
}

interface ReqOpts {
  authenticated?: boolean;
  method?: string;
  sameOrigin?: boolean;
  csrf?: string; // signed CSRF cookie value for the mutating same-origin request
}

function makeReq(path: string, opts: ReqOpts = {}): NextRequest {
  const headers: Record<string, string> = { host: BOARD_HOST };
  if (opts.sameOrigin) headers['referer'] = `${BOARD_ORIGIN}/`;
  const cookies = [];
  if (opts.sameOrigin && opts.authenticated !== false) cookies.push(fixtureTenantCookie(BOARD_HOST));
  if (opts.csrf) cookies.push(`${CSRF_COOKIE_NAME}=${opts.csrf}`);
  headers.cookie = cookies.filter(Boolean).join('; ');
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
 * Credential-failure 401s are delivered via a rewrite to the 401 sink (AUD-71).
 * A `missing-csrf-token` rejection is NOT a credential failure — it is a direct
 * 401 — so this must be FALSE for every rejection asserted below, pinning the
 * narrow signal (not just "some 401").
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

// Real deploy: `next start` forces production. Prove the behavior in production mode.
const TOKEN = 'mc-token-value';
const SECRET = 'webhook-secret-value';

const ENV: EnvOverrides = {
  NODE_ENV: 'production',
  MC_API_TOKEN: TOKEN,
  WEBHOOK_SECRET: SECRET,
  REQUIRE_CF_ACCESS: undefined, // default OFF (opt-in)
  ALLOW_INSECURE_OPEN_API: undefined,
  DEMO_MODE: undefined,
};

/** The HMAC key the server signs the CSRF cookie with under this ENV. */
function csrfSigningSecret(): string {
  return (
    process.env.MC_CSRF_COOKIE_SECRET ||
    process.env.MC_INTERVIEW_COOKIE_SECRET ||
    process.env.MC_API_TOKEN ||
    process.env.WEBHOOK_SECRET ||
    ''
  );
}

/**
 * Mint a CSRF token with a CHOSEN expiry, signed with the server's own key —
 * the same construction signCsrfToken() uses (HMAC-SHA256 over the base64url
 * payload), but with `exp` under our control instead of always now+TTL.
 */
function craftSignedCsrfToken(expUnixSeconds: number): string {
  const payloadB64 = Buffer.from(JSON.stringify({ role: 'csrf', exp: expUnixSeconds })).toString(
    'base64url',
  );
  const sig = createHmac('sha256', csrfSigningSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

describe('CSF-004 mid-sitting CSRF expiry on POST /api/interview/answer (production)', () => {
  it('POSITIVE: properly-signed but PAST-exp token 401s, and a fresh mint on the SAME post passes (typed answer never lost)', async () => {
    const mw = await loadMiddleware(ENV);
    const { signCsrfToken, verifyCsrfToken } = await import('@/lib/csrf-protection');

    // Sanity: our HMAC replication matches the server — same construction with a
    // future exp verifies. So when the stale twin below fails verify, the cause
    // is EXPIRY, not a signature we built wrong.
    const sanity = craftSignedCsrfToken(Math.floor(Date.now() / 1000) + 600);
    expect(await verifyCsrfToken(sanity)).toBe(true);

    // The sitting's token, minted at page load, now a full TTL past expiry: a
    // sitting that outlasted the 1h cookie life. No fake timers — real past exp,
    // genuinely valid HMAC.
    const stale = craftSignedCsrfToken(Math.floor(Date.now() / 1000) - CSRF_COOKIE_TTL_SECONDS - 10);
    expect(await verifyCsrfToken(stale)).toBe(false); // rejected for expiry (see sanity above)

    // Next answer with the stale token: direct 401 missing-csrf-token.
    const first = await mw(makeReq(ANSWER_PATH, { method: 'POST', sameOrigin: true, csrf: stale }));
    expect(first.status).toBe(401);
    expect(isPassthrough(first)).toBe(false);
    expect(isCredentialRejection(first)).toBe(false);

    // Recovery: a fresh mint DIFFERS from the stale token, and the SAME POST
    // with it passes through — the fetch-fresh-token-and-retry-once save path
    // that must never lose the typed answer.
    const { value: fresh } = await signCsrfToken();
    expect(fresh).not.toBe(stale);
    const retry = await mw(makeReq(ANSWER_PATH, { method: 'POST', sameOrigin: true, csrf: fresh }));
    expect(isPassthrough(retry)).toBe(true);
  });

  it('NEGATIVE CONTROL forged signature: well-formed expired payload with a WRONG signature 401s AND mints NOTHING', async () => {
    const mw = await loadMiddleware(ENV);
    const { verifyCsrfToken } = await import('@/lib/csrf-protection');

    const stale = craftSignedCsrfToken(Math.floor(Date.now() / 1000) - CSRF_COOKIE_TTL_SECONDS - 10);
    const forged = stale.slice(0, -1) + (stale.endsWith('A') ? 'B' : 'A');
    expect(forged).not.toBe(stale);
    expect(await verifyCsrfToken(forged)).toBe(false);

    const res = await mw(makeReq(ANSWER_PATH, { method: 'POST', sameOrigin: true, csrf: forged }));
    expect(res.status).toBe(401);
    expect(isPassthrough(res)).toBe(false);
    expect(isCredentialRejection(res)).toBe(false);
    // Narrow mint surface: the rejection carries NO fresh mc_csrf_token Set-Cookie.
    expect(res.headers.get('set-cookie') ?? '').not.toContain(CSRF_COOKIE_NAME);
  });

  it('NEGATIVE CONTROL absent cookie: POST with NO csrf cookie 401s AND mints NOTHING', async () => {
    const mw = await loadMiddleware(ENV);
    const res = await mw(makeReq(ANSWER_PATH, { method: 'POST', sameOrigin: true }));
    expect(res.status).toBe(401);
    expect(isPassthrough(res)).toBe(false);
    expect(isCredentialRejection(res)).toBe(false);
    // Narrow mint surface: the rejection carries NO fresh mc_csrf_token Set-Cookie.
    expect(res.headers.get('set-cookie') ?? '').not.toContain(CSRF_COOKIE_NAME);
  });
});
