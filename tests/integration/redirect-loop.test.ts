/**
 * U022 — No-redirect-loop integration test (hardening).
 *
 * Asserts the interview-mode shell-lock (src/middleware.ts) cannot produce a
 * redirect loop under any cookie state. The middleware 302s unprotected pages
 * to /interview while the interview is incomplete; this test proves:
 *   1. With a valid interview-complete cookie, no page redirects to /interview.
 *   2. Without the cookie, a protected page redirects to /interview exactly
 *      once (a single 302, not a chain/loop).
 *   3. /interview itself NEVER redirects back into the lock — the gate exemption
 *      prevents the infinite loop.
 *
 * This is a NON-E2E integration test that drives the middleware directly via
 * vitest (same pattern as middleware-same-origin-board.test.ts). It mints real
 * HMAC-signed cookies using the same Edge-safe signing function the Node setter
 * uses, so it proves the full sign->verify chain end-to-end within a single
 * process — no server spawn required.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import {
  INTERVIEW_COOKIE_NAME,
  signInterviewToken,
} from '@/lib/interview/gate-cookie';

const TEST_HOST = 'localhost:4000';
const TEST_ORIGIN = `http://${TEST_HOST}`;

const ENV_KEYS = [
  'NODE_ENV',
  'MC_INTERVIEW_COOKIE_SECRET',
  'MC_API_TOKEN',
  'WEBHOOK_SECRET',
  'REQUIRE_CF_ACCESS',
  'ALLOW_INSECURE_OPEN_API',
  'DEMO_MODE',
] as const;

type EnvOverrides = Partial<
  Record<(typeof ENV_KEYS)[number], string | undefined>
>;

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
  /** Cookie value to set under mc_interview_complete. */
  cookie?: string;
  cf?: boolean;
}

function makeReq(path: string, opts: ReqOpts = {}): NextRequest {
  const headers: Record<string, string> = { host: TEST_HOST };
  if (opts.cf) {
    headers['cf-access-jwt-assertion'] = 'edge-verified-jwt';
    headers['cf-access-authenticated-user-email'] = 'operator@example.com';
  }
  if (opts.cookie !== undefined) {
    headers['cookie'] = `${INTERVIEW_COOKIE_NAME}=${opts.cookie}`;
  }
  return new NextRequest(`${TEST_ORIGIN}${path}`, {
    method: opts.method ?? 'GET',
    headers,
  });
}

function isRedirect(res: NextResponse): boolean {
  return res.status >= 300 && res.status < 400;
}

function isPassthrough(res: NextResponse): boolean {
  return res.status === 200 && res.headers.get('x-middleware-next') === '1';
}

function redirectPathname(res: NextResponse): string | null {
  const loc = res.headers.get('location');
  if (!loc) return null;
  try {
    return new URL(loc).pathname;
  } catch {
    return loc;
  }
}

const PROTECTED_PAGES = ['/', '/dashboard', '/settings', '/workspaces'];

const GATE_EXEMPT_PAGES = [
  '/interview',
  '/interview/',
  '/interview/step-1',
  '/onboarding',
  '/onboarding/building',
  '/api/tasks',
  '/api/health',
  '/_next/static/chunk.js',
  '/favicon.ico',
  '/robots.txt',
  '/manifest.json',
];

const COOKIE_SECRET = 'u022-redirect-loop-test-secret';

const BASE_ENV: EnvOverrides = {
  NODE_ENV: 'test',
  MC_INTERVIEW_COOKIE_SECRET: COOKIE_SECRET,
  MC_API_TOKEN: undefined,
  WEBHOOK_SECRET: undefined,
  REQUIRE_CF_ACCESS: undefined,
  ALLOW_INSECURE_OPEN_API: 'true',
  DEMO_MODE: undefined,
};

describe('U022: No-redirect-loop integration test', () => {
  describe('with a valid interview-complete cookie', () => {
    it.each(PROTECTED_PAGES)(
      '%s passes through (200) — no redirect to /interview',
      async (path) => {
        const mw = await loadMiddleware(BASE_ENV);
        const token = await signInterviewToken(true);
        const res = await mw(makeReq(path, { cookie: token.value }));
        expect(isPassthrough(res)).toBe(true);
        expect(isRedirect(res)).toBe(false);
      },
    );

    it('/interview itself also passes through with the complete cookie', async () => {
      const mw = await loadMiddleware(BASE_ENV);
      const token = await signInterviewToken(true);
      const res = await mw(makeReq('/interview', { cookie: token.value }));
      expect(isPassthrough(res)).toBe(true);
    });
  });

  describe('without any interview cookie', () => {
    it.each(PROTECTED_PAGES)(
      '%s redirects to /interview exactly once (no loop)',
      async (path) => {
        const mw = await loadMiddleware(BASE_ENV);
        const res = await mw(makeReq(path, { cookie: undefined }));
        expect(res.status).toBe(302);
        expect(redirectPathname(res)).toBe('/interview');
      },
    );

    it('the redirect Location has no query params (no bounce chain)', async () => {
      const mw = await loadMiddleware(BASE_ENV);
      const res = await mw(makeReq('/', { cookie: undefined }));
      const loc = res.headers.get('location');
      expect(loc).not.toBeNull();
      const parsed = new URL(loc!);
      expect(parsed.pathname).toBe('/interview');
      expect(parsed.search).toBe('');
    });
  });

  describe('/interview and gate-exempt routes NEVER redirect into the lock', () => {
    it.each(GATE_EXEMPT_PAGES)(
      '%s passes through even without an interview cookie (gate exempt)',
      async (path) => {
        const mw = await loadMiddleware(BASE_ENV);
        const res = await mw(makeReq(path, { cookie: undefined }));
        expect(res.status).not.toBe(302);
        expect(isRedirect(res)).toBe(false);
      },
    );
  });

  describe('with a forged/invalid interview cookie', () => {
    it('a protected page redirects to /interview (fail-closed)', async () => {
      const mw = await loadMiddleware(BASE_ENV);
      const forged =
        'eyJjb21wbGV0ZSI6dHJ1ZSwiZXhwIjo5OTk5OTk5OTk5fQ.bad-signature';
      const res = await mw(makeReq('/', { cookie: forged }));
      expect(res.status).toBe(302);
      expect(redirectPathname(res)).toBe('/interview');
    });

    it('/interview itself still passes through with a forged cookie', async () => {
      const mw = await loadMiddleware(BASE_ENV);
      const res = await mw(makeReq('/interview', { cookie: 'evil.evil' }));
      expect(isRedirect(res)).toBe(false);
    });
  });

  describe('with an interview-incomplete cookie (valid signature, complete=false)', () => {
    it('a protected page still redirects to /interview', async () => {
      const mw = await loadMiddleware(BASE_ENV);
      const token = await signInterviewToken(false);
      const res = await mw(makeReq('/', { cookie: token.value }));
      expect(res.status).toBe(302);
      expect(redirectPathname(res)).toBe('/interview');
    });

    it('/interview still passes through', async () => {
      const mw = await loadMiddleware(BASE_ENV);
      const token = await signInterviewToken(false);
      const res = await mw(makeReq('/interview', { cookie: token.value }));
      expect(isRedirect(res)).toBe(false);
    });
  });

  describe('redirect response is a single-step 302 (no chain, no cycle)', () => {
    it('the redirect response does not set the interview cookie', async () => {
      const mw = await loadMiddleware(BASE_ENV);
      const res = await mw(makeReq('/', { cookie: undefined }));
      expect(res.status).toBe(302);
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        expect(setCookie).not.toContain(INTERVIEW_COOKIE_NAME);
      }
    });

    it('following the redirect Location does not redirect again', async () => {
      const mw = await loadMiddleware(BASE_ENV);
      const res1 = await mw(makeReq('/', { cookie: undefined }));
      expect(res1.status).toBe(302);
      const pathname = redirectPathname(res1);
      expect(pathname).toBe('/interview');

      const res2 = await mw(makeReq(pathname!, { cookie: undefined }));
      expect(isRedirect(res2)).toBe(false);
      expect(isPassthrough(res2)).toBe(true);
    });
  });

  describe('POST requests bypass the interview lock', () => {
    it('POST / passes through without interview cookie', async () => {
      const mw = await loadMiddleware(BASE_ENV);
      const res = await mw(
        makeReq('/', { method: 'POST', cookie: undefined }),
      );
      expect(isRedirect(res)).toBe(false);
    });
  });
});
