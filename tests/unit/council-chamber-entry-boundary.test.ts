/**
 * CTR-104 — the Council entry stays behind the real auth boundary.
 *
 * The visual-first change moved what /council RENDERS; it must not move
 * who may reach it. This suite runs the REAL src/middleware.ts against a
 * NextRequest for /council and /council/new, on a registered fixture
 * host, in production posture:
 *
 *   • No session cookie  -> 403 tenant_access_required. The page is not
 *     served, so no chamber and no question box are reachable anonymously.
 *   • Signed tenant session cookie -> NOT 403 (the shell lock takes over),
 *     the known-good control proving the 403 above is an auth decision and
 *     not a blanket refusal of the route.
 *   • The middleware matcher still covers /council (it is not an
 *     un-matched static path), and the council entry was not added to any
 *     public-path exemption.
 *
 * Run: node --import tsx --test tests/unit/council-chamber-entry-boundary.test.ts
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const HOST = 'board.example.com';
const TENANT_SECRET = 'ctr104-fixture-tenant-secret';

type MiddlewareModule = {
  middleware: (request: unknown) => Promise<{
    status: number;
    headers: { get: (name: string) => string | null };
    text: () => Promise<string>;
  }>;
  config: { matcher: string[] };
};

let mod: MiddlewareModule;
let NextRequest: new (input: URL, init?: { headers?: Record<string, string> }) => unknown;

before(async () => {
  process.env.NODE_ENV = 'production';
  process.env.MC_API_TOKEN = 'ctr104-fixture-token';
  process.env.WEBHOOK_SECRET = 'ctr104-fixture-webhook-secret';
  process.env.MC_TENANT_SESSION_SECRET = TENANT_SECRET;
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    [HOST]: {
      tenantId: 'fixture-self',
      companyId: 'default',
      kind: 'self',
      installationId: 'fixture-install',
    },
  });
  ({ NextRequest } = (await import('next/server')) as unknown as {
    NextRequest: typeof NextRequest;
  });
  mod = (await import('../../src/middleware')) as unknown as MiddlewareModule;
});

function tenantCookie(): string {
  const payload = Buffer.from(
    JSON.stringify({
      purpose: 'session',
      tenantId: 'fixture-self',
      companyId: 'default',
      subject: 'owner:fixture',
      host: HOST,
      installationId: 'fixture-install',
      exp: Date.now() / 1000 + 3600,
      nonce: 'fixture-browser',
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', TENANT_SECRET).update(payload).digest('base64url');
  return `mc_tenant_session=${payload}.${sig}`;
}

async function callRoute(pathname: string, cookie?: string) {
  const headers: Record<string, string> = { host: HOST, 'x-forwarded-host': HOST };
  if (cookie) headers.cookie = cookie;
  const request = new NextRequest(new URL(`https://${HOST}${pathname}`), { headers });
  return mod.middleware(request);
}

test('the middleware matcher still covers the council entry routes', () => {
  const rx = new RegExp(`^${mod.config.matcher[0]}$`);
  assert.equal(rx.test('/council'), true, '/council must run through middleware');
  assert.equal(rx.test('/council/new'), true, '/council/new must run through middleware');
  assert.equal(rx.test('/_next/static/chunk.js'), false, 'static assets stay un-matched');
});

test('an unauthenticated visitor never receives the council chamber', async () => {
  for (const pathname of ['/council', '/council/new']) {
    const response = await callRoute(pathname);
    assert.equal(response.status, 403, `${pathname} must refuse an unauthenticated caller`);
    const body = await response.text();
    assert.match(body, /tenant_access_required/);
  }
});

test('control: a signed tenant session changes the outcome (not a blanket refusal)', async () => {
  const anonymous = await callRoute('/council');
  const authorized = await callRoute('/council', tenantCookie());
  assert.equal(anonymous.status, 403);
  assert.notEqual(
    authorized.status,
    403,
    'with a signed tenant session the shell lock decides, so the 403 above is an auth decision',
  );
});
