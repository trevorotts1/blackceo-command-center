/**
 * FLEET-FIX 2.3 / AUD-71 — middleware 401 telemetry, END TO END.
 *
 * This suite drives the REAL pipeline, in order, with no stubs in the middle:
 *
 *   src/middleware.ts  (Edge contract)
 *     -> NextResponse.rewrite() headers
 *       -> src/app/api/internal/auth-rejected/route.ts  (Node sink)
 *         -> src/lib/probes/unauthorized-401-store.ts   (authoritative counter)
 *           -> probeUnauthorized401()                   (health surface)
 *             -> runAllProbes()                         (/api/system/status)
 *
 * `dispatchRewrite()` below is the deliberate seam. Next.js dispatches a
 * middleware rewrite by reading the `x-middleware-rewrite` /
 * `x-middleware-request-*` headers off the middleware's response and re-issuing
 * the request to the destination with those headers applied. The helper does
 * exactly that, from the middleware's ACTUAL response — so if the middleware
 * stops emitting the rewrite, or emits the wrong destination, or drops a header,
 * these tests fail. It is not a re-implementation of the contract, it is a
 * transcription of Next's dispatch step.
 *
 * The cross-RUNTIME half (Edge isolate vs Node isolate) is the one thing a
 * single-process test cannot prove, because the test runs everything in one Node
 * realm. That is proved separately against a real `next build && next start`
 * server by tests/e2e/prove-401-telemetry.e2e.mjs.
 *
 * What each case pins down (the five defects of the first cut):
 *   1. the counter reaches the health surface at all (was: producer, no consumer)
 *   2. the count read back is REAL, not a constant 0
 *   3. missing-header vs token-mismatch are DISTINCT (was: both 'Unauthorized')
 *   4. the caller UA is emitted (was: absent)
 *   5. a misconfiguration 401 does NOT increment the counter (was: it did)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import {
  AUTH_REJECTED_PATH,
  AUTH_REJECT_HEADERS,
} from '@/lib/probes/unauthorized-401-contract';

const HOST = 'board.example.com';
const ORIGIN = `https://${HOST}`;
const TOKEN = 'mc-token-value';
const UA = 'cc-dept-agent/1.0 (write-back probe)';

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

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // The store hangs off globalThis (it must, to survive Next's per-route
  // bundling), so vi.resetModules() alone does NOT zero it. Reset explicitly or
  // counts bleed between cases.
  const store = await import('@/lib/probes/unauthorized-401-store');
  store.__resetUnauthorized401Store();
  vi.resetModules();
  vi.restoreAllMocks();
});

type Middleware = (req: NextRequest) => Promise<NextResponse>;

interface Pipeline {
  mw: Middleware;
  sink: typeof import('@/app/api/internal/auth-rejected/route');
  probe: typeof import('@/lib/probes/unauthorized-401-probe');
}

/**
 * Load the middleware, the sink route and the probe from ONE fresh module
 * registry, after setting env (the middleware snapshots MC_API_TOKEN et al into
 * module constants at import time).
 */
async function loadPipeline(env: EnvOverrides): Promise<Pipeline> {
  for (const k of ENV_KEYS) {
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const mwMod = await import('@/middleware');
  const sink = await import('@/app/api/internal/auth-rejected/route');
  const probe = await import('@/lib/probes/unauthorized-401-probe');
  return { mw: mwMod.middleware as Middleware, sink, probe };
}

interface ReqOpts {
  method?: string;
  sameOrigin?: boolean;
  origin?: string;
  bearer?: string;
  ua?: string | null;
  cfAccess?: boolean;
}

function makeReq(path: string, opts: ReqOpts = {}): NextRequest {
  const headers: Record<string, string> = { host: HOST };
  if (opts.sameOrigin) headers['referer'] = `${ORIGIN}/`;
  if (opts.origin) headers['origin'] = opts.origin;
  if (opts.bearer) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.ua !== null) headers['user-agent'] = opts.ua ?? UA;
  if (opts.cfAccess) {
    headers['cf-access-jwt-assertion'] = 'jwt.stub.value';
    headers['cf-access-authenticated-user-email'] = 'operator@example.com';
  }
  return new NextRequest(`${ORIGIN}${path}`, {
    method: opts.method ?? 'GET',
    headers,
  });
}

/** Did the middleware rewrite this request, and to where? */
function rewriteTarget(res: NextResponse): string | null {
  const raw = res.headers.get('x-middleware-rewrite');
  if (!raw) return null;
  try {
    return new URL(raw, ORIGIN).pathname;
  } catch {
    return raw;
  }
}

/**
 * Transcribe Next's rewrite dispatch: take the middleware's response, read the
 * request-header overrides it encoded, and issue the destination request the way
 * the Next server would. Returns the sink route's actual response.
 */
async function dispatchRewrite(
  res: NextResponse,
  sink: Pipeline['sink'],
  original: NextRequest
): Promise<Response> {
  const target = res.headers.get('x-middleware-rewrite');
  if (!target) throw new Error('middleware did not rewrite — nothing to dispatch');

  // Start from the original request headers, then apply the middleware's
  // overrides exactly as the Next server does.
  const headers = new Headers(original.headers);
  const overridden = res.headers.get('x-middleware-override-headers');
  if (overridden) {
    for (const name of overridden.split(',').map((s) => s.trim()).filter(Boolean)) {
      const value = res.headers.get(`x-middleware-request-${name}`);
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
  }

  const method = original.method.toUpperCase();
  const req = new NextRequest(new URL(target, ORIGIN), { method, headers });

  const handler = (sink as unknown as Record<string, (r: NextRequest) => Response>)[method];
  if (!handler) throw new Error(`sink route exports no ${method} handler`);
  return handler(req);
}

/** Production, secrets provisioned, no CF Access — the plain-tunnel box. */
const BASE_ENV: EnvOverrides = {
  NODE_ENV: 'production',
  MC_API_TOKEN: TOKEN,
  WEBHOOK_SECRET: undefined,
  REQUIRE_CF_ACCESS: undefined,
  ALLOW_INSECURE_OPEN_API: undefined,
  DEMO_MODE: undefined,
};

describe('AUD-71 defect 3 — the reject reason is DISCRIMINATED', () => {
  it('a request with NO Authorization header reports reason exactly "missing-header"', async () => {
    const { mw } = await loadPipeline(BASE_ENV);

    const res = await mw(makeReq('/api/tasks/42/activities', { method: 'POST' }));

    expect(rewriteTarget(res)).toBe(AUTH_REJECTED_PATH);
    expect(res.headers.get(`x-middleware-request-${AUTH_REJECT_HEADERS.reason}`)).toBe(
      'missing-header'
    );
  });

  it('a request with the WRONG bearer reports reason exactly "token-mismatch"', async () => {
    const { mw } = await loadPipeline(BASE_ENV);

    const res = await mw(
      makeReq('/api/tasks/42/activities', { method: 'POST', bearer: 'stale-token' })
    );

    expect(rewriteTarget(res)).toBe(AUTH_REJECTED_PATH);
    expect(res.headers.get(`x-middleware-request-${AUTH_REJECT_HEADERS.reason}`)).toBe(
      'token-mismatch'
    );
  });

  it('the two reasons are DIFFERENT values (the whole diagnostic point)', async () => {
    const { mw } = await loadPipeline(BASE_ENV);

    const missing = await mw(makeReq('/api/tasks', {}));
    const mismatch = await mw(makeReq('/api/tasks', { bearer: 'nope' }));

    const rMissing = missing.headers.get(`x-middleware-request-${AUTH_REJECT_HEADERS.reason}`);
    const rMismatch = mismatch.headers.get(`x-middleware-request-${AUTH_REJECT_HEADERS.reason}`);

    expect(rMissing).toBe('missing-header');
    expect(rMismatch).toBe('token-mismatch');
    expect(rMissing).not.toBe(rMismatch);
  });

  it('the response body still says only "Unauthorized" — the reason is for the operator, not the caller', async () => {
    const { mw, sink } = await loadPipeline(BASE_ENV);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeReq('/api/tasks', { bearer: 'nope' });
    const res = await dispatchRewrite(await mw(req), sink, req);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});

describe('AUD-71 defect 4 — the caller User-Agent is emitted', () => {
  it('carries the caller UA on the telemetry event and into the structured log line', async () => {
    const { mw, sink } = await loadPipeline(BASE_ENV);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeReq('/api/tasks', { ua: UA });
    const res = await mw(req);

    expect(res.headers.get(`x-middleware-request-${AUTH_REJECT_HEADERS.ua}`)).toBe(UA);

    await dispatchRewrite(res, sink, req);

    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(line).toMatchObject({
      event: 'middleware_401',
      status: 401,
      pathname: '/api/tasks',
      method: 'GET',
      reason: 'missing-header',
      ua: UA,
      count: 1,
      sink: 'node-sink',
    });
    expect(Number.isNaN(Date.parse(line.ts))).toBe(false);
  });

  it('a caller that sends NO User-Agent yields ua: null — not a fabricated string', async () => {
    const { mw, sink, probe } = await loadPipeline(BASE_ENV);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeReq('/api/tasks', { ua: null });
    await dispatchRewrite(await mw(req), sink, req);

    const result = await probe.probeUnauthorized401();
    expect(result.detail?.lastUa).toBeNull();
  });

  it('a UA carrying CRLF cannot inject a header — it is flattened', async () => {
    const { mw } = await loadPipeline(BASE_ENV);

    // NextRequest/undici rejects raw CRLF in a header value, so the injection has
    // to be attempted through a value the sanitizer is responsible for flattening.
    const { sanitizeHeaderValue } = await import('@/lib/probes/unauthorized-401-contract');
    expect(sanitizeHeaderValue('evil\r\nx-admin: 1')).toBe('evil x-admin: 1');
    expect(sanitizeHeaderValue('a'.repeat(9000))?.length).toBe(256);
    expect(sanitizeHeaderValue(null)).toBeNull();
    expect(sanitizeHeaderValue('   ')).toBeNull();

    // And the middleware only ever sets the sanitized value.
    const res = await mw(makeReq('/api/tasks', { ua: 'x'.repeat(9000) }));
    const emitted = res.headers.get(`x-middleware-request-${AUTH_REJECT_HEADERS.ua}`);
    expect(emitted?.length).toBe(256);
  });
});

describe('AUD-71 defect 5 — the counter does NOT count misconfiguration 401s', () => {
  it('the Cloudflare-Access-not-active response is a 401 by status, yet is NOT rewritten and NOT counted', async () => {
    const { mw, probe } = await loadPipeline({ ...BASE_ENV, REQUIRE_CF_ACCESS: 'true' });

    // No CF headers -> the misconfiguration branch. It takes the DEFAULT status
    // (401) — this is the exact response the first cut mis-counted, because it
    // filtered on `status === 401` instead of on the signal.
    const res = await mw(makeReq('/api/tasks', { bearer: TOKEN }));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('Cloudflare Access is not active'),
    });

    // The proof: no rewrite was emitted, so the Node sink is never reached...
    expect(rewriteTarget(res)).toBeNull();

    // ...and the credential-failure counter is therefore still zero.
    const result = await probe.probeUnauthorized401();
    expect(result.detail?.count).toBe(0);
    expect(result.status).toBe('live');
  });

  it('a misconfiguration 401 mixed in with real credential failures leaves the count at exactly the real ones', async () => {
    const { mw, sink, probe } = await loadPipeline({ ...BASE_ENV, REQUIRE_CF_ACCESS: 'true' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Two REAL credential failures (CF headers present, so we get past Layer 1).
    for (const bearer of [undefined, 'wrong']) {
      const req = makeReq('/api/tasks', { cfAccess: true, bearer });
      await dispatchRewrite(await mw(req), sink, req);
    }
    // Three misconfiguration 401s (no CF headers).
    for (let i = 0; i < 3; i++) {
      const res = await mw(makeReq('/api/tasks', { bearer: TOKEN }));
      expect(res.status).toBe(401);
      expect(rewriteTarget(res)).toBeNull();
    }

    const result = await probe.probeUnauthorized401();
    expect(result.detail?.count).toBe(2); // NOT 5
    expect(result.detail?.byReason).toEqual({ 'missing-header': 1, 'token-mismatch': 1 });
  });

  it('the 503 misconfiguration branches (MC_API_TOKEN / WEBHOOK_SECRET unset) are not counted either', async () => {
    const noToken = await loadPipeline({ ...BASE_ENV, MC_API_TOKEN: undefined });
    const res503 = await noToken.mw(makeReq('/api/tasks', { origin: 'https://evil.example.com' }));
    expect(res503.status).toBe(503);
    expect(rewriteTarget(res503)).toBeNull();
    expect((await noToken.probe.probeUnauthorized401()).detail?.count).toBe(0);

    const noSecret = await loadPipeline({ ...BASE_ENV, WEBHOOK_SECRET: undefined });
    const resHook = await noSecret.mw(makeReq('/api/tasks/ingest', { method: 'POST' }));
    expect(resHook.status).toBe(503);
    expect(rewriteTarget(resHook)).toBeNull();
    expect((await noSecret.probe.probeUnauthorized401()).detail?.count).toBe(0);
  });

  it('a 200 same-origin passthrough is not rewritten and not counted', async () => {
    const { mw, probe } = await loadPipeline(BASE_ENV);

    const res = await mw(makeReq('/api/tasks', { sameOrigin: true }));

    expect(res.status).toBe(200);
    expect(rewriteTarget(res)).toBeNull();
    expect((await probe.probeUnauthorized401()).detail?.count).toBe(0);
  });
});

describe('AUD-71 — the sink route is internal-only', () => {
  it('a DIRECT inbound request to the sink path is 404ed by the middleware before any auth logic', async () => {
    const { mw } = await loadPipeline(BASE_ENV);

    // Even holding a valid bearer, a caller cannot reach the sink handler and
    // forge the per-reason breakdown.
    const res = await mw(
      new NextRequest(`${ORIGIN}${AUTH_REJECTED_PATH}`, {
        method: 'POST',
        headers: {
          host: HOST,
          authorization: `Bearer ${TOKEN}`,
          [AUTH_REJECT_HEADERS.reason]: 'token-mismatch',
        },
      })
    );

    expect(res.status).toBe(404);
    expect(rewriteTarget(res)).toBeNull();
  });

  it('the sink refuses to count an absent or forged reason', async () => {
    const { sink, probe } = await loadPipeline(BASE_ENV);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Reason absent.
    const bare = new NextRequest(`${ORIGIN}${AUTH_REJECTED_PATH}`, {
      method: 'POST',
      headers: { host: HOST },
    });
    expect((await sink.POST(bare)).status).toBe(401);

    // Reason present but not a credential-failure reason (e.g. someone trying to
    // launder a misconfiguration signal into the counter).
    const forged = new NextRequest(`${ORIGIN}${AUTH_REJECTED_PATH}`, {
      method: 'POST',
      headers: { host: HOST, [AUTH_REJECT_HEADERS.reason]: 'cf-access-misconfigured' },
    });
    expect((await sink.POST(forged)).status).toBe(401);

    expect((await probe.probeUnauthorized401()).detail?.count).toBe(0);
  });
});

describe('AUD-71 — an HTTP verb the sink cannot be rewritten to is answered, logged, and honestly left uncounted', () => {
  it('PROPFIND gets the same 401 body, a log line with count: null, and no fabricated count', async () => {
    const { mw, probe } = await loadPipeline(BASE_ENV);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await mw(makeReq('/api/tasks', { method: 'PROPFIND' }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(rewriteTarget(res)).toBeNull();

    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(line).toMatchObject({
      event: 'middleware_401',
      reason: 'missing-header',
      method: 'PROPFIND',
      ua: UA,
      count: null,
      sink: 'middleware-direct',
    });

    // Honest: uncounted, never mis-counted.
    expect((await probe.probeUnauthorized401()).detail?.count).toBe(0);
  });
});
