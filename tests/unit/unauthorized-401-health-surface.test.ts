/**
 * FLEET-FIX 2.3 / AUD-71 — the counter is EXPOSED VIA THE HEALTH ENDPOINT.
 *
 * The first cut of this unit shipped `getUnauthorized401Count()` and then called
 * it from nothing but its own test: a producer with zero consumers, which is the
 * spec's own E3 defect verbatim. The spec clause is "increment a counter exposed
 * via the existing health endpoint" — so the thing that has to be asserted is
 * the HEALTH SURFACE, not the counter function.
 *
 * This suite therefore asserts against `runAllProbes()` — the exact function
 * `GET /api/system/status` calls (src/app/api/system/status/route.ts ->
 * getSystemStatus -> runAllProbes) — and proves:
 *
 *   1. `unauthorized_401` is a component in the payload at all (registration),
 *   2. the count it reports MOVES with real rejections (it is not a constant 0),
 *   3. the per-reason breakdown distinguishes missing-header from token-mismatch,
 *   4. the caller UA is on the surface,
 *   5. a misconfiguration 401 does not move it,
 *   6. the probe result is handed to persistSnapshot() — i.e. it lands in
 *      system_status_snapshots like every other component.
 *
 * The sibling probes are stubbed (they do real network/disk/subprocess work and
 * would make this suite slow and flaky); `probeUnauthorized401` and the store
 * under it are the REAL modules. `getDb` is stubbed so persistSnapshot can be
 * observed without a database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ProbeResult } from '@/lib/probes/types';
import { AUTH_REJECT_HEADERS } from '@/lib/probes/unauthorized-401-contract';

const ORIGIN = 'https://board.example.com';

/** A stub ProbeResult for every sibling probe, so runAllProbes stays hermetic. */
function stub(component: string): () => Promise<ProbeResult> {
  return async () => ({
    component,
    label: component,
    status: 'live',
    latencyMs: 1,
    probedAt: new Date().toISOString(),
  });
}

const persisted: ProbeResult[] = [];

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    prepare: () => ({
      run: () => {
        /* observed via the components list; see the persistSnapshot test */
      },
    }),
  }),
}));

vi.mock('@/lib/probes/db', () => ({ probeDatabase: stub('database') }));
vi.mock('@/lib/probes/openclaw-gateway', () => ({ probeOpenClawGateway: stub('openclaw_gateway') }));
vi.mock('@/lib/probes/model-providers', () => ({ probeModelProviders: async () => [] }));
vi.mock('@/lib/probes/telegram', () => ({ probeTelegram: stub('telegram') }));
vi.mock('@/lib/probes/memory', () => ({ probeMemory: stub('memory') }));
vi.mock('@/lib/probes/jobs', () => ({ probeJobs: stub('jobs') }));
vi.mock('@/lib/probes/disk', () => ({ probeDisk: stub('disk') }));
vi.mock('@/lib/probes/agents', () => ({ probeAgents: stub('agents') }));
vi.mock('@/lib/probes/cli-probe', () => ({ probeCli: stub('cli') }));
vi.mock('@/lib/probes/cloudflare-tunnel-probe', () => ({
  probeCloudflareTunnel: stub('cloudflare_tunnel'),
}));
vi.mock('@/lib/probes/cloudflare-access-probe', () => ({
  probeCloudflareAccess: stub('cloudflare_access'),
  recordCfAccessSeen: () => {},
}));

const TOKEN = 'mc-token-value';
const UA = 'cc-dept-agent/1.0';

beforeEach(async () => {
  persisted.length = 0;
  process.env.NODE_ENV = 'production';
  process.env.MC_API_TOKEN = TOKEN;
  delete process.env.REQUIRE_CF_ACCESS;
  delete process.env.ALLOW_INSECURE_OPEN_API;
  delete process.env.DEMO_MODE;
  const store = await import('@/lib/probes/unauthorized-401-store');
  store.__resetUnauthorized401Store();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  const store = await import('@/lib/probes/unauthorized-401-store');
  store.__resetUnauthorized401Store();
  vi.restoreAllMocks();
});

/**
 * Drive one REAL rejected request all the way through the middleware and the
 * Node sink route — the same seam tests/unit/middleware-401-telemetry.test.ts
 * documents (Next dispatches a rewrite by applying the `x-middleware-request-*`
 * overrides to the destination request).
 */
async function reject(opts: { path?: string; bearer?: string; ua?: string | null }): Promise<void> {
  const { middleware } = await import('@/middleware');
  const sink = await import('@/app/api/internal/auth-rejected/route');

  const headers: Record<string, string> = { host: 'board.example.com' };
  if (opts.bearer) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.ua !== null) headers['user-agent'] = opts.ua ?? UA;

  const path = opts.path ?? '/api/tasks/7/activities';
  const req = new NextRequest(`${ORIGIN}${path}`, { method: 'POST', headers });
  const res = await middleware(req);

  const target = res.headers.get('x-middleware-rewrite');
  if (!target) throw new Error(`expected a rewrite for ${path}, got status ${res.status}`);

  const dest = new Headers(req.headers);
  const overridden = res.headers.get('x-middleware-override-headers') ?? '';
  for (const name of overridden.split(',').map((s) => s.trim()).filter(Boolean)) {
    const v = res.headers.get(`x-middleware-request-${name}`);
    if (v === null) dest.delete(name);
    else dest.set(name, v);
  }

  const sinkRes = await sink.POST(new NextRequest(new URL(target, ORIGIN), {
    method: 'POST',
    headers: dest,
  }));
  expect(sinkRes.status).toBe(401);
}

function componentOf(components: ProbeResult[], name: string): ProbeResult | undefined {
  return components.find((c) => c.component === name);
}

describe('AUD-71 defects 1 + 2 — the health surface reports a REAL count', () => {
  it('registration: /api/system/status carries an `unauthorized_401` component', async () => {
    const { runAllProbes } = await import('@/lib/system-status');

    const payload = await runAllProbes();

    const comp = componentOf(payload.components, 'unauthorized_401');
    expect(comp).toBeDefined();
    expect(comp!.label).toBe('Unauthorized 401s');
    expect(comp!.detail?.count).toBe(0);
  });

  it('ACCEPTANCE: after real rejections the health surface reports a NON-ZERO count end to end', async () => {
    await reject({ bearer: undefined }); // missing-header
    await reject({ bearer: 'stale' }); // token-mismatch
    await reject({ bearer: 'stale' }); // token-mismatch

    const { runAllProbes } = await import('@/lib/system-status');
    const payload = await runAllProbes();
    const comp = componentOf(payload.components, 'unauthorized_401')!;

    // The number the spec asked to expose — real, not 0.
    expect(comp.detail?.count).toBe(3);

    // Discriminated, so an operator can tell the two faults apart from the board.
    expect(comp.detail?.byReason).toEqual({
      'missing-header': 1,
      'token-mismatch': 2,
    });

    // The caller UA is on the surface too.
    expect(comp.detail?.lastUa).toBe(UA);
    expect(comp.detail?.lastPathname).toBe('/api/tasks/7/activities');
    expect(comp.detail?.lastMethod).toBe('POST');
    expect(comp.detail?.lastReason).toBe('token-mismatch');
  });

  it('recent credential failures degrade the component (the write-back trap is visible on the pill)', async () => {
    const { runAllProbes } = await import('@/lib/system-status');

    const clean = componentOf((await runAllProbes()).components, 'unauthorized_401')!;
    expect(clean.status).toBe('live');
    expect(clean.error).toBeUndefined();

    await reject({ bearer: 'stale' });

    const dirty = componentOf((await runAllProbes()).components, 'unauthorized_401')!;
    expect(dirty.status).toBe('degraded');
    expect(dirty.error).toContain('bad/missing credentials');
    expect(dirty.detail?.recentCount).toBe(1);
  });

  it('the signal self-clears: an OLD failure keeps the lifetime count but no longer degrades', async () => {
    await reject({ bearer: 'stale' });

    const { readUnauthorized401Counters } = await import('@/lib/probes/unauthorized-401-store');
    const { probeUnauthorized401, UNAUTHORIZED_401_WINDOW_MS } = await import(
      '@/lib/probes/unauthorized-401-probe'
    );

    // Read the store from a point in time beyond the window.
    const future = Date.now() + UNAUTHORIZED_401_WINDOW_MS + 1000;
    expect(readUnauthorized401Counters(future).recentCount).toBe(0);
    expect(readUnauthorized401Counters(future).total).toBe(1);

    // Now the probe (which reads at "now") is still degraded...
    expect((await probeUnauthorized401()).status).toBe('degraded');

    // ...but once the window passes, the lifetime count survives and the status
    // returns to live. Simulate by advancing the clock.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(future));
    const settled = await probeUnauthorized401();
    vi.useRealTimers();

    expect(settled.status).toBe('live');
    expect(settled.detail?.count).toBe(1);
    expect(settled.detail?.recentCount).toBe(0);
  });

  it('defect 5 on the health surface: a misconfiguration 401 leaves the exposed count at 0', async () => {
    // REQUIRE_CF_ACCESS with no CF headers -> the misconfiguration 401 branch.
    process.env.REQUIRE_CF_ACCESS = 'true';
    vi.resetModules();
    const { middleware } = await import('@/middleware');

    const res = await middleware(
      new NextRequest(`${ORIGIN}/api/tasks`, {
        method: 'POST',
        headers: { host: 'board.example.com', authorization: `Bearer ${TOKEN}` },
      })
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();

    const { runAllProbes } = await import('@/lib/system-status');
    const comp = componentOf((await runAllProbes()).components, 'unauthorized_401')!;

    expect(comp.detail?.count).toBe(0);
    expect(comp.status).toBe('live');
  });
});

describe('AUD-71 — the probe result is persisted like every other component', () => {
  it('persistSnapshot() receives the unauthorized_401 row', async () => {
    const rows: unknown[][] = [];
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: () => ({ run: (...args: unknown[]) => rows.push(args) }),
      }),
    }));
    vi.resetModules();

    await reject({ bearer: 'stale' });

    const { runAllProbes } = await import('@/lib/system-status');
    await runAllProbes();

    // system_status_snapshots INSERT is (probed_at, component, status, latency, error, metadata)
    const row = rows.find((r) => r[1] === 'unauthorized_401');
    expect(row).toBeDefined();
    const metadata = JSON.parse(row![5] as string);
    expect(metadata.count).toBe(1);
    expect(metadata.byReason).toEqual({ 'missing-header': 0, 'token-mismatch': 1 });

    vi.doUnmock('@/lib/db');
  });
});

describe('AUD-71 — the sink route accepts the internal headers it is given', () => {
  it('records exactly the pathname/method/reason/ua the middleware handed it', async () => {
    const sink = await import('@/app/api/internal/auth-rejected/route');
    const { probeUnauthorized401 } = await import('@/lib/probes/unauthorized-401-probe');

    const res = await sink.POST(
      new NextRequest(`${ORIGIN}/api/internal/auth-rejected`, {
        method: 'POST',
        headers: {
          host: 'board.example.com',
          [AUTH_REJECT_HEADERS.reason]: 'token-mismatch',
          [AUTH_REJECT_HEADERS.pathname]: '/api/tasks/99/deliverables',
          [AUTH_REJECT_HEADERS.method]: 'PATCH',
          [AUTH_REJECT_HEADERS.ua]: 'curl/8.4.0',
        },
      })
    );

    expect(res.status).toBe(401);

    const detail = (await probeUnauthorized401()).detail!;
    expect(detail.count).toBe(1);
    expect(detail.lastReason).toBe('token-mismatch');
    expect(detail.lastPathname).toBe('/api/tasks/99/deliverables');
    expect(detail.lastMethod).toBe('PATCH');
    expect(detail.lastUa).toBe('curl/8.4.0');
  });
});
