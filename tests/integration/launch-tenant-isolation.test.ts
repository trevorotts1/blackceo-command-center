/**
 * L11 / UL-001 — launch tenant isolation (synthetic local fixtures only).
 *
 * WHAT THIS LOCKS
 *   1. Every launch page and launch read API resolves a VERIFIED tenant
 *      identity before its handler/page component runs. An anonymous or
 *      forged-header caller gets a 403 with no launch material.
 *   2. A SHARED installation (more than one registered tenant identity, or a
 *      client-kind proxy host) refuses launch rendering entirely
 *      (`launch_tenant_unscoped`) — a guessed id can never expose another
 *      tenant's list, detail page, server-component payload or API body,
 *      because the read never starts.
 *   3. Operator (bearer) access is NOT a cross-tenant bypass on a shared
 *      installation — it is refused there too.
 *   4. A single-tenant installation keeps working unchanged, and demo mode
 *      does not become an unauthenticated launch surface.
 *   5. The reader contract (launchRecordVisible) refuses unattributed records
 *      on shared installations and any foreign tenant/company claim; a
 *      client_slug is never proof of ownership.
 *
 * Fixtures are synthetic: tenant A, tenant B, a client-kind host and the
 * operator bearer. No real provider, file store or network is touched — the
 * interview gate fallback is mocked and never fetched.
 *
 * Run: npx vitest run tests/integration/launch-tenant-isolation.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

// The shell lock calls this on page admissions; mock it so the suite is
// hermetic (no localhost fetch, no live Command Center).
vi.mock('@/lib/interview/gate-fallback', () => ({
  checkInterviewCompleteViaFallback: async () => true,
}));

const TENANT_SECRET = 'l11-synthetic-tenant-session-secret';
const INTERVIEW_SECRET = 'l11-synthetic-interview-secret';
const OPERATOR_TOKEN = 'l11-synthetic-operator-bearer';
const WEBHOOK_SECRET_VALUE = 'l11-synthetic-webhook-secret';

const HOST_A = 'shared-a.example.test';
const HOST_B = 'shared-b.example.test';
const HOST_SOLO = 'solo.example.test';
const HOST_CLIENT = 'client.example.test';
const HOST_UNREGISTERED = 'nowhere.example.test';

interface Registration {
  tenantId: string;
  companyId: string;
  kind: 'self' | 'client';
  installationId: string;
  clientId?: string;
}

const TENANT_A: Registration = { tenantId: 'tenant-a', companyId: 'company-a', kind: 'self', installationId: 'install-a' };
const TENANT_B: Registration = { tenantId: 'tenant-b', companyId: 'company-b', kind: 'self', installationId: 'install-b' };
const CLIENT_HOST: Registration = {
  tenantId: 'hq-tenant', companyId: 'company-hq', kind: 'client', clientId: 'client-a', installationId: 'install-hq',
};

const SHARED_REGISTRY = { [HOST_A]: TENANT_A, [HOST_B]: TENANT_B };
const SOLO_REGISTRY = { [HOST_SOLO]: TENANT_A };
const CLIENT_REGISTRY = { [HOST_CLIENT]: CLIENT_HOST };

const ENV_KEYS = [
  'MC_TENANT_REGISTRY_JSON',
  'NODE_ENV',
  'MC_API_TOKEN',
  'WEBHOOK_SECRET',
  'REQUIRE_CF_ACCESS',
  'ALLOW_INSECURE_OPEN_API',
  'DEMO_MODE',
  'MC_TENANT_SESSION_SECRET',
  'MC_INTERVIEW_COOKIE_SECRET',
  'MC_COMPANY_ID',
  'MC_INSTALLATION_ID',
  'CC_PUBLIC_URL',
  'INTERVIEW_TENANT_TRUST_LOCAL',
  'CC_PORT',
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
  vi.restoreAllMocks();
  vi.resetModules();
});

function applyEnv(registry: Record<string, Registration>, overrides: EnvOverrides = {}): void {
  const merged: EnvOverrides = {
    NODE_ENV: 'test',
    MC_API_TOKEN: OPERATOR_TOKEN,
    WEBHOOK_SECRET: WEBHOOK_SECRET_VALUE,
    REQUIRE_CF_ACCESS: undefined,
    ALLOW_INSECURE_OPEN_API: undefined,
    DEMO_MODE: undefined,
    MC_TENANT_SESSION_SECRET: TENANT_SECRET,
    MC_INTERVIEW_COOKIE_SECRET: INTERVIEW_SECRET,
    MC_TENANT_REGISTRY_JSON: JSON.stringify(registry),
    ...overrides,
  };
  for (const k of ENV_KEYS) {
    const v = merged[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

type Middleware = (req: NextRequest) => Promise<NextResponse>;

async function loadMiddleware(registry: Record<string, Registration>, overrides: EnvOverrides = {}): Promise<Middleware> {
  applyEnv(registry, overrides);
  vi.resetModules();
  const mod = await import('@/middleware');
  return mod.middleware as Middleware;
}

/** A genuine signed tenant session grant (same HMAC the helper verifies). */
function sessionCookie(host: string, registration: Registration): string {
  const payload = Buffer.from(JSON.stringify({
    purpose: 'session',
    tenantId: registration.tenantId,
    companyId: registration.companyId,
    subject: `owner:${registration.tenantId}`,
    host,
    installationId: registration.installationId,
    exp: Date.now() / 1000 + 3600,
    nonce: `l11-nonce-${registration.tenantId}`,
  })).toString('base64url');
  const signature = createHmac('sha256', TENANT_SECRET).update(payload).digest('base64url');
  return `mc_tenant_session=${payload}.${signature}`;
}

/** A genuine interview-complete cookie bound to the tenant scope. */
async function interviewCookie(host: string, registration: Registration): Promise<string> {
  const { signInterviewToken } = await import('@/lib/interview/gate-cookie');
  const { value } = await signInterviewToken(
    true,
    `${registration.tenantId}:${registration.installationId}:${host}`,
  );
  return `mc_interview_complete=${value}`;
}

interface ReqOpts {
  method?: string;
  cookie?: string;
  bearer?: string;
  sameOrigin?: boolean;
  accept?: string;
  extraHeaders?: Record<string, string>;
}

function makeReq(host: string, path: string, opts: ReqOpts = {}): NextRequest {
  const headers: Record<string, string> = {
    host,
    accept: opts.accept ?? 'application/json',
  };
  if (opts.sameOrigin) headers.referer = `https://${host}/`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  Object.assign(headers, opts.extraHeaders);
  return new NextRequest(`https://${host}${path}`, { method: opts.method ?? 'GET', headers });
}

function isPassthrough(res: NextResponse): boolean {
  return res.status === 200 && res.headers.get('x-middleware-next') === '1';
}

async function bodyText(res: NextResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

const LAUNCH_READ_PATHS = [
  '/api/launch-runs?launch_id=guessed-launch-b',
  '/api/launch-abilities?launch_id=guessed-launch-b',
  '/launch',
  '/launch/guessed-launch-b',
];

describe('shared installation (tenants A+B): launch reads disabled, no cross-tenant material', () => {
  it('tenant A list read is refused with launch_tenant_unscoped', async () => {
    const mw = await loadMiddleware(SHARED_REGISTRY);
    const res = await mw(makeReq(HOST_A, '/api/launch-runs', { cookie: sessionCookie(HOST_A, TENANT_A), sameOrigin: true }));
    expect(isPassthrough(res)).toBe(false);
    expect(res.status).toBe(403);
    expect(await bodyText(res)).toContain('launch_tenant_unscoped');
  });

  it('tenant B guessed detail id on its own host is refused — the id never reaches a reader', async () => {
    const mw = await loadMiddleware(SHARED_REGISTRY);
    for (const path of ['/api/launch-runs?launch_id=guessed-launch-b', '/api/launch-abilities?launch_id=guessed-launch-b']) {
      const res = await mw(makeReq(HOST_B, path, { cookie: sessionCookie(HOST_B, TENANT_B), sameOrigin: true }));
      expect(isPassthrough(res)).toBe(false);
      expect(res.status).toBe(403);
      const body = await bodyText(res);
      expect(body).toContain('launch_tenant_unscoped');
      expect(body).not.toContain('guessed-launch-b');
      expect(body).not.toContain('offer-b');
      expect(body).not.toContain(TENANT_B.tenantId);
    }
  });

  it('tenant A launch page navigation is refused as HTML with no launch material', async () => {
    const mw = await loadMiddleware(SHARED_REGISTRY);
    const res = await mw(makeReq(HOST_A, '/launch/guessed-launch-b', {
      cookie: sessionCookie(HOST_A, TENANT_A),
      accept: 'text/html,application/xhtml+xml',
    }));
    expect(isPassthrough(res)).toBe(false);
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type') || '').toContain('text/html');
    const body = await bodyText(res);
    expect(body).toContain('Launch data unavailable');
    expect(body).not.toContain('guessed-launch-b');
    expect(body).not.toContain('offer-b');
  });

  it('OPERATOR bearer is not a cross-tenant bypass on a shared installation', async () => {
    const mw = await loadMiddleware(SHARED_REGISTRY);
    for (const path of LAUNCH_READ_PATHS) {
      for (const bearer of [OPERATOR_TOKEN]) {
        const res = await mw(makeReq(HOST_A, path, { bearer, sameOrigin: true, accept: 'application/json' }));
        expect(isPassthrough(res), `${path} must not pass for the operator bearer`).toBe(false);
        expect(res.status).toBe(403);
        expect(await bodyText(res)).toContain('launch_tenant_unscoped');
      }
    }
  });

  it('a React Server Component payload request is refused at the same boundary (no RSC data)', async () => {
    const mw = await loadMiddleware(SHARED_REGISTRY);
    const res = await mw(makeReq(HOST_A, '/launch/guessed-launch-b', {
      cookie: sessionCookie(HOST_A, TENANT_A),
      accept: 'text/x-component',
      extraHeaders: { rsc: '1', 'next-router-prefetch': '1' },
    }));
    expect(isPassthrough(res)).toBe(false);
    expect(res.status).toBe(403);
    // RSC requests are not document navigations: JSON refusal, still no data.
    const body = await bodyText(res);
    expect(body).toContain('launch_tenant_unscoped');
    expect(body).not.toContain('guessed-launch-b');
    expect(body).not.toContain('offer-b');
  });

  it('client-kind proxy host is treated as shared and refused', async () => {
    const mw = await loadMiddleware(CLIENT_REGISTRY);
    const res = await mw(makeReq(HOST_CLIENT, '/api/launch-runs', {
      cookie: sessionCookie(HOST_CLIENT, CLIENT_HOST),
      sameOrigin: true,
    }));
    expect(isPassthrough(res)).toBe(false);
    expect(res.status).toBe(403);
    expect(await bodyText(res)).toContain('launch_tenant_unscoped');
  });

  it('anonymous forged same-origin caller is refused before any read', async () => {
    const mw = await loadMiddleware(SHARED_REGISTRY);
    for (const path of LAUNCH_READ_PATHS) {
      const res = await mw(makeReq(HOST_A, path, { sameOrigin: true }));
      expect(isPassthrough(res)).toBe(false);
      expect(res.status).toBe(403);
      expect(await bodyText(res)).toContain('launch_tenant_required');
    }
  });

  it('a spoofed x-tenant-id header is not authority', async () => {
    const mw = await loadMiddleware(SHARED_REGISTRY);
    const res = await mw(makeReq(HOST_A, '/api/launch-runs', {
      sameOrigin: true,
      extraHeaders: {
        'x-tenant-id': TENANT_B.tenantId,
        'x-company-id': TENANT_B.companyId,
        'x-operator-email': 'attacker@example.test',
      },
    }));
    expect(isPassthrough(res)).toBe(false);
    expect(res.status).toBe(403);
    expect(await bodyText(res)).toContain('launch_tenant_required');
  });

  it('refusals emit no launch material to the console/logs', async () => {
    const mw = await loadMiddleware(SHARED_REGISTRY);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mw(makeReq(HOST_B, '/api/launch-runs?launch_id=guessed-launch-b', {
      cookie: sessionCookie(HOST_B, TENANT_B),
      sameOrigin: true,
    }));
    const all = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((v) => (typeof v === 'string' ? v : ''))
      .join('\n');
    expect(all).not.toContain('guessed-launch-b');
    expect(all).not.toContain('offer-b');
  });
});

describe('single-tenant installation: launch reads keep working for the box tenant', () => {
  it('tenant A list API passes the middleware gate', async () => {
    const mw = await loadMiddleware(SOLO_REGISTRY);
    const res = await mw(makeReq(HOST_SOLO, '/api/launch-runs', {
      cookie: sessionCookie(HOST_SOLO, TENANT_A),
      sameOrigin: true,
    }));
    expect(isPassthrough(res)).toBe(true);
  });

  it('tenant A launch detail page passes the middleware gate', async () => {
    const mw = await loadMiddleware(SOLO_REGISTRY);
    const cookie = [
      sessionCookie(HOST_SOLO, TENANT_A),
      await interviewCookie(HOST_SOLO, TENANT_A),
    ].join('; ');
    const res = await mw(makeReq(HOST_SOLO, '/launch/2026-10-01-launch', {
      cookie,
      accept: 'text/html',
    }));
    expect(isPassthrough(res)).toBe(true);
  });

  it('the box operator bearer passes on its OWN single-tenant installation', async () => {
    const mw = await loadMiddleware(SOLO_REGISTRY);
    const res = await mw(makeReq(HOST_SOLO, '/api/launch-abilities', {
      bearer: OPERATOR_TOKEN,
      sameOrigin: true,
    }));
    expect(isPassthrough(res)).toBe(true);
  });

  it('anonymous launch page is refused (never redirected into a public surface)', async () => {
    const mw = await loadMiddleware(SOLO_REGISTRY);
    const res = await mw(makeReq(HOST_SOLO, '/launch', { accept: 'text/html' }));
    expect(isPassthrough(res)).toBe(false);
    expect(res.status).toBe(403);
    const body = await bodyText(res);
    expect(body).toContain('Launch data unavailable');
    expect(body).toContain('Sign in with an authorized account');
  });

  it('DEMO_MODE does not open a public launch surface', async () => {
    const mw = await loadMiddleware(SOLO_REGISTRY, { DEMO_MODE: 'true' });
    const res = await mw(makeReq(HOST_SOLO, '/api/launch-runs', { sameOrigin: true }));
    expect(isPassthrough(res)).toBe(false);
    expect(res.status).toBe(403);
    expect(await bodyText(res)).toContain('launch_tenant_required');
  });

  it('an unregistered host is refused', async () => {
    const mw = await loadMiddleware(SOLO_REGISTRY);
    const res = await mw(makeReq(HOST_UNREGISTERED, '/launch', { accept: 'text/html' }));
    expect(isPassthrough(res)).toBe(false);
    expect(res.status).toBe(403);
  });
});

describe('reader contract: launchRecordVisible / launchHostIsShared / resolveLaunchAccess', () => {
  it('a single-tenant installation owns unattributed records; a shared one never does', async () => {
    const helper = await import('@/lib/auth/tenant-context');

    applyEnv(SOLO_REGISTRY);
    expect(helper.launchHostIsShared(HOST_SOLO)).toBe(false);
    const solo = await helper.resolveLaunchAccess({ headers: new Headers({ cookie: sessionCookie(HOST_SOLO, TENANT_A), host: HOST_SOLO }) });
    expect(solo.sharedHost).toBe(false);
    expect(helper.launchRecordVisible(solo, null)).toBe(true);
    expect(helper.launchRecordVisible(solo, {})).toBe(true);

    applyEnv(SHARED_REGISTRY);
    expect(helper.launchHostIsShared(HOST_A)).toBe(true);
    const shared = await helper.resolveLaunchAccess({ headers: new Headers({ cookie: sessionCookie(HOST_A, TENANT_A), host: HOST_A }) });
    expect(shared.sharedHost).toBe(true);
    expect(helper.launchRecordVisible(shared, null)).toBe(false);
    expect(helper.launchRecordVisible(shared, {})).toBe(false);
  });

  it('an owned record is visible only on an exact tenant+company match; client_slug is not proof', async () => {
    applyEnv(SHARED_REGISTRY);
    const helper = await import('@/lib/auth/tenant-context');
    const shared = await helper.resolveLaunchAccess({ headers: new Headers({ cookie: sessionCookie(HOST_A, TENANT_A), host: HOST_A }) });

    expect(helper.launchRecordVisible(shared, { tenant_id: TENANT_A.tenantId, company_id: TENANT_A.companyId })).toBe(true);
    expect(helper.launchRecordVisible(shared, { tenant_id: TENANT_B.tenantId })).toBe(false);
    expect(helper.launchRecordVisible(shared, { tenant_id: TENANT_A.tenantId, company_id: TENANT_B.companyId })).toBe(false);
    expect(helper.launchRecordVisible(shared, { company_id: TENANT_B.companyId })).toBe(false);
    // A label is not ownership.
    expect(helper.launchRecordVisible(shared, { client_slug: TENANT_A.tenantId })).toBe(false);
    // Wrong types never become truthy claims.
    expect(helper.launchRecordVisible(shared, { tenant_id: 42, company_id: null })).toBe(false);
  });

  it('resolveLaunchAccess refuses an unauthenticated caller', async () => {
    applyEnv(SOLO_REGISTRY);
    const helper = await import('@/lib/auth/tenant-context');
    await expect(helper.resolveLaunchAccess({ headers: new Headers({ host: HOST_SOLO }) }))
      .rejects.toThrow(/verified tenant identity/i);
  });
});
