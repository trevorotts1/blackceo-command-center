/**
 * No-redirect-loop integration test (U022 — hardening).
 *
 * Nothing was broken: the interview shell lock (src/middleware.ts, P0-5 / WG-9)
 * already whitelists /interview and /onboarding/*, and completion is terminal.
 * This suite locks the invariant down so a future middleware change cannot
 * SILENTLY reintroduce a redirect loop:
 *
 *   1. A valid interview-complete cookie → NO page redirects to /interview.
 *   2. No cookie → a protected page redirects to /interview EXACTLY ONCE —
 *      and /interview itself never redirects back into the lock (no loop).
 *   3. The exempt surfaces (/interview, /onboarding/*) are never redirected,
 *      with or without the cookie.
 *   4. Completion is terminal: an EXPIRED-but-signature-valid "complete" token
 *      still unlocks (it never reverts).
 *   5. Fail-closed: a forged / invalid token redirects to /interview.
 *
 * The middleware reads its env into module-level constants at import time, so
 * each scenario sets process.env then re-imports the module with a fresh
 * registry (vi.resetModules + dynamic import) — the same pattern as
 * tests/unit/middleware-same-origin-board.test.ts. The interview cookie is
 * minted with the REAL signInterviewToken() under a test secret, so the
 * middleware's verifyInterviewToken() exercises the genuine sign/verify path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const COOKIE_NAME = 'mc_interview_complete';
const TEST_SECRET = 'u022-redirect-loop-test-secret';
const BASE = 'https://cc.example.com';

const ENV_KEYS = [
  'NODE_ENV',
  'MC_API_TOKEN',
  'WEBHOOK_SECRET',
  'REQUIRE_CF_ACCESS',
  'ALLOW_INSECURE_OPEN_API',
  'DEMO_MODE',
  'MC_INTERVIEW_COOKIE_SECRET',
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

/** Set env, then import the middleware with a fresh module registry. */
async function loadMiddleware(env: EnvOverrides = {}): Promise<Middleware> {
  const merged: EnvOverrides = {
    NODE_ENV: 'test',
    MC_API_TOKEN: 'u022-test-token',
    WEBHOOK_SECRET: 'u022-webhook-secret',
    REQUIRE_CF_ACCESS: 'false',
    ALLOW_INSECURE_OPEN_API: undefined,
    DEMO_MODE: undefined,
    MC_INTERVIEW_COOKIE_SECRET: TEST_SECRET,
    ...env,
  };
  for (const k of ENV_KEYS) {
    const v = merged[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const mod = await import('@/middleware');
  return mod.middleware as Middleware;
}

/** Mint a REAL signed interview cookie (genuine sign/verify path). */
async function mintCookie(complete: boolean): Promise<string> {
  const { signInterviewToken } = await import('@/lib/interview/gate-cookie');
  const { value } = await signInterviewToken(complete);
  return value;
}

function pageRequest(path: string, cookie?: string): NextRequest {
  const headers = new Headers();
  if (cookie) headers.set('cookie', `${COOKIE_NAME}=${cookie}`);
  return new NextRequest(new URL(path, BASE), { method: 'GET', headers });
}

/** Where does this response redirect to (null = not a redirect)? */
function redirectTarget(res: NextResponse): string | null {
  const loc = res.headers.get('location');
  if (!loc) return null;
  if (res.status !== 302 && res.status !== 307 && res.status !== 308) return null;
  try {
    return new URL(loc).pathname;
  } catch {
    return loc;
  }
}

describe('interview shell-lock redirect invariants (U022)', () => {
  it('a valid complete cookie → no page redirects to /interview', async () => {
    const mw = await loadMiddleware();
    const cookie = await mintCookie(true);
    for (const path of ['/', '/tasks', '/departments', '/analytics']) {
      const res = await mw(pageRequest(path, cookie));
      expect(redirectTarget(res), `${path} must not redirect`).toBeNull();
      expect(res.status).toBe(200);
    }
  });

  it('no cookie → a protected page redirects to /interview exactly once (no loop)', async () => {
    const mw = await loadMiddleware();
    // Hop 1: the protected page redirects to /interview.
    const res = await mw(pageRequest('/'));
    expect(redirectTarget(res)).toBe('/interview');
    // Hop 2: /interview itself is exempt — it must NOT redirect again.
    // A loop would send the browser back to /interview forever.
    const atInterview = await mw(pageRequest('/interview'));
    expect(redirectTarget(atInterview), '/interview must not redirect (loop!)').toBeNull();
    expect(atInterview.status).toBe(200);
  });

  it('/interview and its subpaths are exempt with ANY cookie state', async () => {
    const mw = await loadMiddleware();
    const complete = await mintCookie(true);
    const incomplete = await mintCookie(false);
    for (const cookie of [undefined, complete, incomplete]) {
      for (const path of ['/interview', '/interview/welcome', '/interview/review']) {
        const res = await mw(pageRequest(path, cookie));
        expect(redirectTarget(res), `${path} must be exempt`).toBeNull();
      }
    }
  });

  it('/onboarding/* is exempt (resume redirect + building page)', async () => {
    const mw = await loadMiddleware();
    for (const path of ['/onboarding/resume/abc123', '/onboarding/building']) {
      const res = await mw(pageRequest(path));
      expect(redirectTarget(res), `${path} must be exempt`).toBeNull();
      expect(res.status).toBe(200);
    }
  });

  it('completion is terminal: an expired-but-signed complete token still unlocks', async () => {
    const mw = await loadMiddleware();
    // The middleware gates on verdict.complete, NOT verdict.valid — completion
    // never reverts, so an expired-but-signature-valid "complete" token must
    // still unlock. Mint one by replicating the cookie's exact HMAC-SHA256
    // signing (same secret, same b64url format) with a PAST exp, so the
    // signature is genuine and only the expiry is in the past.
    const crypto = await import('node:crypto');
    const b64url = (b: Buffer) =>
      b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = { complete: true, exp: Math.floor(Date.now() / 1000) - 3600 }; // expired 1h ago
    const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
    const sig = b64url(
      crypto.createHmac('sha256', TEST_SECRET).update(payloadB64).digest(),
    );
    const expiredComplete = `${payloadB64}.${sig}`;

    // Sanity: the token is signature-valid but expired.
    const { verifyInterviewToken } = await import('@/lib/interview/gate-cookie');
    const verdict = await verifyInterviewToken(expiredComplete);
    expect(verdict.complete).toBe(true); // terminal — survives expiry
    expect(verdict.valid).toBe(false); // …but past exp

    // The middleware must NOT redirect: completion is terminal.
    const res = await mw(pageRequest('/', expiredComplete));
    expect(redirectTarget(res), 'expired-but-valid complete token must unlock').toBeNull();
    expect(res.status).toBe(200);
  });

  it('fail-closed: a forged cookie redirects to /interview', async () => {
    const mw = await loadMiddleware();
    const forged = `${Buffer.from(JSON.stringify({ complete: true, exp: Math.floor(Date.now() / 1000) + 9999 }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}.forged-signature`;
    const res = await mw(pageRequest('/', forged));
    expect(redirectTarget(res)).toBe('/interview');
  });

  it('fail-closed: an incomplete cookie redirects to /interview', async () => {
    const mw = await loadMiddleware();
    const incomplete = await mintCookie(false);
    const res = await mw(pageRequest('/', incomplete));
    expect(redirectTarget(res)).toBe('/interview');
  });

  it('only GET/HEAD navigations are gated (server-action POSTs pass)', async () => {
    const mw = await loadMiddleware();
    const req = new NextRequest(new URL('/', BASE), { method: 'POST' });
    const res = await mw(req);
    expect(redirectTarget(res)).toBeNull();
    expect(res.status).toBe(200);
  });
});
