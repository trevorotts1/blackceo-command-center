/**
 * MR-17 fix2 — interview-bypass replay guard, exercised through the REAL
 * middleware (src/middleware.ts), not just the token helpers.
 *
 * WHY THIS EXISTS (regression lock):
 *   The first MR-17 fix made the bypass nonce single-use on BOTH surfaces. That
 *   broke U057 "Skip for now": the browser resends the SAME httpOnly cookie on
 *   every navigation, so consuming the nonce on the first page load bounced the
 *   operator back to /interview on the SECOND load (a hard feature regression,
 *   proven empirically before this correction). The corrected design splits the
 *   nonce semantics by surface:
 *     • `mc_interview_bypass` COOKIE → NON-consuming TTL session grant. Every
 *       page load within the 1h TTL is admitted (this suite locks that in).
 *     • `?bypass_interview=` URL → SINGLE-USE. The first load is admitted, a
 *       replay of the same URL is redirected to /interview (the capture-prone
 *       surface Haiku flagged — browser history / proxy log / Referer).
 *
 *   It also locks the cross-realm reality: the cookie is minted by a Node server
 *   action that lives in a DIFFERENT VM realm than the Edge middleware, so its
 *   nonce is normally UNRECOGNISED in the middleware's ledger. The cookie verifier
 *   must admit a well-formed, unexpired nonce regardless of ledger membership, or
 *   the feature breaks in production even on the first load.
 *
 * Runs under vitest only (vi.resetModules re-import of the middleware), same
 * pattern as tests/integration/redirect-loop.test.ts — see vitest.config.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const BYPASS_COOKIE = 'mc_interview_bypass';
const TEST_SECRET = 'mr17-bypass-replay-test-secret';
const BASE = 'https://cc.example.com';

const ENV_KEYS = [
  'NODE_ENV', 'MC_API_TOKEN', 'WEBHOOK_SECRET', 'REQUIRE_CF_ACCESS',
  'ALLOW_INSECURE_OPEN_API', 'DEMO_MODE', 'MC_INTERVIEW_COOKIE_SECRET',
] as const;

let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => { savedEnv = {}; for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  vi.resetModules();
});

type Middleware = (req: NextRequest) => Promise<NextResponse>;

async function loadMiddleware(): Promise<Middleware> {
  const merged: Record<string, string | undefined> = {
    NODE_ENV: 'test', MC_API_TOKEN: 't', WEBHOOK_SECRET: 'w',
    REQUIRE_CF_ACCESS: 'false', ALLOW_INSECURE_OPEN_API: undefined,
    DEMO_MODE: undefined, MC_INTERVIEW_COOKIE_SECRET: TEST_SECRET,
  };
  for (const k of ENV_KEYS) { const v = merged[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.resetModules();
  const mod = await import('@/middleware');
  return mod.middleware as Middleware;
}

/** A genuinely HMAC-signed bypass token whose nonce was NOT recorded in this
 *  realm's ledger — exactly what the Edge middleware sees from a Node-minted
 *  cookie (cross-realm). */
async function mintCrossRealmToken(nonce: string, expOffsetSec = 3600): Promise<string> {
  const crypto = await import('node:crypto');
  const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = { exp: Math.floor(Date.now() / 1000) + expOffsetSec, nonce };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(crypto.createHmac('sha256', TEST_SECRET).update(payloadB64).digest());
  return `${payloadB64}.${sig}`;
}

function pageReq(path: string, opts: { cookie?: string; bypassParam?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.cookie) headers.set('cookie', `${BYPASS_COOKIE}=${opts.cookie}`);
  const url = new URL(path, BASE);
  if (opts.bypassParam) url.searchParams.set('bypass_interview', opts.bypassParam);
  return new NextRequest(url, { method: 'GET', headers });
}

function redirectTarget(res: NextResponse): string | null {
  const loc = res.headers.get('location');
  if (!loc) return null;
  if (res.status !== 302 && res.status !== 307 && res.status !== 308) return null;
  try { return new URL(loc).pathname; } catch { return loc; }
}

describe('MR-17 fix2 — bypass replay guard through the real middleware', () => {
  it('COOKIE: a "Skip for now" session admits EVERY page load for the TTL (non-consuming)', async () => {
    const mw = await loadMiddleware();
    // Node-minted cookie = valid signature + nonce absent from the middleware's
    // ledger (cross-realm reality).
    const cookie = await mintCrossRealmToken('node-realm-session-nonce');
    for (const path of ['/', '/tasks', '/departments', '/analytics', '/']) {
      const res = await mw(pageReq(path, { cookie }));
      expect(redirectTarget(res), `${path} must stay admitted for the whole session`).toBeNull();
      expect(res.status).toBe(200);
    }
  });

  it('URL: the ?bypass_interview= escape hatch is SINGLE-USE — first load admitted, replay redirected', async () => {
    const mw = await loadMiddleware();
    const token = await mintCrossRealmToken('one-time-url-nonce');
    // First presentation of the URL admits.
    const first = await mw(pageReq('/', { bypassParam: token }));
    expect(redirectTarget(first)).toBeNull();
    expect(first.status).toBe(200);
    // A replay of the SAME captured URL is refused → bounced to /interview.
    const replay = await mw(pageReq('/', { bypassParam: token }));
    expect(redirectTarget(replay)).toBe('/interview');
  });

  it('COOKIE: an expired bypass token is refused (TTL is the revocation bound)', async () => {
    const mw = await loadMiddleware();
    const expired = await mintCrossRealmToken('expired-nonce', -10); // expired 10s ago
    const res = await mw(pageReq('/', { cookie: expired }));
    expect(redirectTarget(res)).toBe('/interview');
  });

  it('COOKIE: a tampered/forged bypass token is refused (fail closed)', async () => {
    const mw = await loadMiddleware();
    const good = await mintCrossRealmToken('forge-nonce');
    const [payload] = good.split('.');
    const forged = `${payload}.forged-signature`;
    const res = await mw(pageReq('/', { cookie: forged }));
    expect(redirectTarget(res)).toBe('/interview');
  });

  it('no bypass at all → still redirected to /interview (gate intact)', async () => {
    const mw = await loadMiddleware();
    const res = await mw(pageReq('/'));
    expect(redirectTarget(res)).toBe('/interview');
  });
});
