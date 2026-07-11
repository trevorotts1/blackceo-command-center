/**
 * FLEET-FIX 2.3 / AUD-71 — middleware 401 structured logging + counter.
 *
 * The CC write-back auth train (`23c9ef2` -> v5.1.0/v5.1.1) rebuilt
 * `src/middleware.ts` around the `unauthorized(request, message, status)`
 * helper (DATA-09/10/11, G15-AUTH-HARDEN) but left it emitting NO structured
 * log and incrementing NO counter on a 401 — this is the numbered unit the
 * otherwise-complete train silently dropped. This suite proves the fix:
 *
 *   1. A 401 request emits exactly ONE structured JSON log line AND
 *      increments the counter by exactly 1 (the acceptance test, both
 *      halves asserted together on the same request).
 *   2. The log line and the counter agree with each other and with the
 *      response that actually went out.
 *   3. Multiple 401s each get their own log line and the counter keeps pace.
 *   4. NEGATIVE FIXTURE: a 503 misconfiguration response (routed through the
 *      SAME `unauthorized()` helper, just a different status) does NOT emit
 *      the 401 log line and does NOT touch the 401 counter — proving the
 *      counter isn't just "every call to unauthorized()" in disguise.
 *   5. NEGATIVE FIXTURE: a 200 passthrough emits nothing and leaves the
 *      counter untouched.
 *
 * Same pattern as tests/unit/middleware-same-origin-board.test.ts: the
 * middleware reads its env into module-level constants at import time and
 * the new probe module keeps its counter in module-level state, so every
 * scenario sets process.env then re-imports both modules with a fresh
 * registry (vi.resetModules + dynamic import) to get an isolated counter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const HOST = 'board.example.com';
const ORIGIN = `https://${HOST}`;
const TOKEN = 'mc-token-value';

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
  vi.restoreAllMocks();
});

type Middleware = (req: NextRequest) => Promise<NextResponse>;
type ProbeModule = typeof import('@/lib/probes/unauthorized-401-probe');

/**
 * Loads the middleware AND the probe module from the SAME fresh module
 * registry (one vi.resetModules() call, then both dynamic imports) so the
 * probe's module-level counter observed by the test is the exact instance
 * the middleware itself is incrementing — not a second, disconnected copy.
 */
async function loadMiddlewareAndProbe(
  env: EnvOverrides
): Promise<{ mw: Middleware; probe: ProbeModule }> {
  for (const k of ENV_KEYS) {
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const mwMod = await import('@/middleware');
  const probe = await import('@/lib/probes/unauthorized-401-probe');
  return { mw: mwMod.middleware as Middleware, probe };
}

interface ReqOpts {
  method?: string;
  sameOrigin?: boolean;
  origin?: string;
  bearer?: string;
}

function makeReq(path: string, opts: ReqOpts = {}): NextRequest {
  const headers: Record<string, string> = { host: HOST };
  if (opts.sameOrigin) headers['referer'] = `${ORIGIN}/`;
  if (opts.origin) headers['origin'] = opts.origin;
  if (opts.bearer) headers['authorization'] = `Bearer ${opts.bearer}`;
  return new NextRequest(`${ORIGIN}${path}`, {
    method: opts.method ?? 'GET',
    headers,
  });
}

// Production, secrets provisioned, no CF Access — same baseline as the
// same-origin-board suite's "plain Cloudflare Tunnel box" scenario.
const BASE_ENV: EnvOverrides = {
  NODE_ENV: 'production',
  MC_API_TOKEN: TOKEN,
  WEBHOOK_SECRET: undefined,
  REQUIRE_CF_ACCESS: undefined,
  ALLOW_INSECURE_OPEN_API: undefined,
  DEMO_MODE: undefined,
};

describe('middleware 401 telemetry (FLEET-FIX 2.3 / AUD-71)', () => {
  it('ACCEPTANCE: a 401 request emits exactly one structured log line AND increments the counter by 1', async () => {
    const { mw, probe } = await loadMiddlewareAndProbe(BASE_ENV);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(probe.getUnauthorized401Count()).toBe(0);

    const res = await mw(makeReq('/api/tasks', { origin: 'https://evil.example.com' }));

    expect(res.status).toBe(401);

    // COUNTER fired.
    expect(probe.getUnauthorized401Count()).toBe(1);

    // STRUCTURED LOG fired — exactly once.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const raw = warnSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      event: 'middleware_401',
      status: 401,
      pathname: '/api/tasks',
      method: 'GET',
      count: 1,
    });
    expect(typeof parsed.reason).toBe('string');
    expect(parsed.reason.length).toBeGreaterThan(0);
    expect(typeof parsed.ts).toBe('string');
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
  });

  it('a 401 from the bearer-mismatch path also fires the log line + counter', async () => {
    const { mw, probe } = await loadMiddlewareAndProbe(BASE_ENV);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await mw(makeReq('/api/tasks', { bearer: 'not-the-token' }));

    expect(res.status).toBe(401);
    expect(probe.getUnauthorized401Count()).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(parsed.event).toBe('middleware_401');
    expect(parsed.status).toBe(401);
  });

  it('THREE separate 401 requests produce THREE log lines and a counter of 3', async () => {
    const { mw, probe } = await loadMiddlewareAndProbe(BASE_ENV);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mw(makeReq('/api/tasks', { origin: 'https://evil.example.com' }));
    await mw(makeReq('/api/workspaces', { bearer: 'wrong-1' }));
    await mw(makeReq('/api/departments', { bearer: 'wrong-2' }));

    expect(probe.getUnauthorized401Count()).toBe(3);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    const counts = warnSpy.mock.calls.map((c) => JSON.parse(c[0] as string).count);
    expect(counts).toEqual([1, 2, 3]);
  });

  it('NEGATIVE FIXTURE: a 503 misconfiguration response (same unauthorized() helper) does NOT fire the 401 log or counter', async () => {
    const { mw, probe } = await loadMiddlewareAndProbe({
      ...BASE_ENV,
      MC_API_TOKEN: undefined, // triggers the 503 fail-closed branch, not a 401
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await mw(makeReq('/api/tasks', { origin: 'https://evil.example.com' }));

    expect(res.status).toBe(503);
    expect(probe.getUnauthorized401Count()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('NEGATIVE FIXTURE: a 200 passthrough emits nothing and leaves the counter at 0', async () => {
    const { mw, probe } = await loadMiddlewareAndProbe(BASE_ENV);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await mw(makeReq('/api/tasks', { sameOrigin: true }));

    expect(res.status).toBe(200);
    expect(probe.getUnauthorized401Count()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('__resetUnauthorized401Counter() (test-only) zeroes the counter', async () => {
    const { mw, probe } = await loadMiddlewareAndProbe(BASE_ENV);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mw(makeReq('/api/tasks', { origin: 'https://evil.example.com' }));
    expect(probe.getUnauthorized401Count()).toBe(1);

    probe.__resetUnauthorized401Counter();
    expect(probe.getUnauthorized401Count()).toBe(0);
  });
});
