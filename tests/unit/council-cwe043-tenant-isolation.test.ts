/**
 * council-cwe043-tenant-isolation.test.ts: CWE-043 composed
 * authorization battery (directive Sections 28.2, 35; build step 1).
 *
 * Independent QA leg: the composed product (CWE-050 assembly over
 * the accepted units) is attacked through its REAL route handlers
 * with the Section 28.2 surface: direct URLs with guessed IDs,
 * modified query parameters, replayed cursors, stale cookies,
 * switched company context, a credential presented to the wrong
 * host, query-string credentials, CSRF-less mutations, and foreign
 * mutations. Every denial must be indistinguishable from absence
 * (no existence oracle), and a denied mutation must change nothing.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-cwe043-tenant-isolation.test.ts
 */

import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';
import { signCsrfToken } from '../../src/lib/csrf-protection';

const ENV_KEYS = [
  'MC_TENANT_REGISTRY_JSON',
  'MC_TENANT_SESSION_SECRET',
  'MC_INTERVIEW_COOKIE_SECRET',
  'MC_API_TOKEN',
  'MC_CSRF_COOKIE_SECRET',
  'MC_COUNCIL_SUPPORT_SUBJECTS',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

const SESSION_SECRET = 'cwe043-session-secret-fixture';
const OPERATOR_TOKEN = 'cwe043-operator-token-fixture';
const CSRF_SECRET = 'cwe043-csrf-secret-fixture';

const HOSTS = {
  'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', installationId: 'install-a' },
  'council-a2.test': { tenantId: 'tenant-a', companyId: 'company-a2', installationId: 'install-a' },
  'council-b.test': { tenantId: 'tenant-b', companyId: 'company-b', installationId: 'install-b' },
} as const;
type Host = keyof typeof HOSTS;

function installFixtureEnv(): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', kind: 'self', installationId: 'install-a' },
    'council-a2.test': { tenantId: 'tenant-a', companyId: 'company-a2', kind: 'self', installationId: 'install-a' },
    'council-b.test': { tenantId: 'tenant-b', companyId: 'company-b', kind: 'self', installationId: 'install-b' },
  });
  process.env.MC_TENANT_SESSION_SECRET = SESSION_SECRET;
  process.env.MC_API_TOKEN = OPERATOR_TOKEN;
  process.env.MC_CSRF_COOKIE_SECRET = CSRF_SECRET;
  delete process.env.MC_INTERVIEW_COOKIE_SECRET;
  delete process.env.MC_COUNCIL_SUPPORT_SUBJECTS;
}

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

type RouteHandler = (request: NextRequest, ctx?: unknown) => Promise<Response>;
let sessionsRoute: { POST: RouteHandler };
let sessionRoute: { GET: RouteHandler };
let eventsRoute: { GET: RouteHandler };
let cancelRoute: { POST: RouteHandler };
let startRoute: { POST: RouteHandler };
let exportRoute: { GET: RouteHandler };
let closeDbFn: () => void;
let db: import('better-sqlite3').Database;

before(async () => {
  installFixtureEnv();
  sessionsRoute = await import('../../src/app/api/council/sessions/route');
  sessionRoute = await import('../../src/app/api/council/sessions/[id]/route');
  eventsRoute = await import('../../src/app/api/council/sessions/[id]/events/route');
  cancelRoute = await import('../../src/app/api/council/sessions/[id]/cancel/route');
  startRoute = await import('../../src/app/api/council/sessions/[id]/start/route');
  exportRoute = await import('../../src/app/api/council/exports/[exportId]/route');
  const dbModule = await import('../../src/lib/db');
  closeDbFn = dbModule.closeDb;
  db = dbModule.getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run('company-a', 'Company A', 'company-a', now, now);
});

after(() => {
  closeDbFn();
});

const ALICE = 'owner:alice';
const BOB = 'owner:bob';
const PRIVATE_MARKER = 'CWE043-PRIVATE-QUESTION-MARKER';

async function grantCookie(
  host: Host,
  subject: string,
  expOffsetSeconds = 3600,
): Promise<string> {
  const reg = HOSTS[host];
  const token = await signTenantGrant({
    purpose: 'session',
    tenantId: reg.tenantId,
    companyId: reg.companyId,
    subject,
    host,
    installationId: reg.installationId,
    exp: Math.floor(Date.now() / 1000) + expOffsetSeconds,
    nonce: `cwe043-${subject}-${Math.random()}`,
  });
  return `mc_tenant_session=${token}`;
}

async function request(
  host: Host,
  path: string,
  options: {
    method?: string;
    subject?: string | null;
    cookieOverride?: string;
    csrf?: boolean;
    body?: unknown;
    idempotencyKey?: string;
  } = {},
): Promise<NextRequest> {
  const headers: Record<string, string> = { host };
  const cookies: string[] = [];
  if (options.cookieOverride) cookies.push(options.cookieOverride);
  else if (options.subject !== null) {
    cookies.push(await grantCookie(host, options.subject ?? ALICE));
  }
  if (options.csrf) {
    const { value } = await signCsrfToken();
    cookies.push(`mc_csrf_token=${value}`);
  }
  if (cookies.length > 0) headers.cookie = cookies.join('; ');
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return new NextRequest(`https://${host}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function draftBody(visibility: 'private' | 'company', question = 'Should we pilot the revised offer?'): Record<string, unknown> {
  return {
    mode: 'selected',
    visibility,
    seat_ids: ['simon-sinek', 'brene-brown'],
    source_pack_version: 'pack-fixture-1.0.0',
    model_policy: {
      selection: 'explicit',
      route_id: 'route-fixture-1',
      requested_model_id: 'model-selected-by-client',
      reasoning_preference: null,
      fallback_policy: 'none',
    },
    brief: {
      question,
      options: [
        { id: 'A', label: 'Keep the current offer', kind: 'status_quo' },
        { id: 'B', label: 'Pilot the revised offer', kind: 'bounded_test' },
      ],
      facts: [],
      assumptions: [],
      unknowns: [],
      constraints: [],
      relevance_weights: { 'simon-sinek': 2, 'brene-brown': 3 },
      critical_domains: [],
      evidence_manifest: [],
      private_preference_ref: null,
      display_timezone: 'America/New_York',
    },
  };
}

async function createDraft(
  visibility: 'private' | 'company',
  question?: string,
): Promise<string> {
  installFixtureEnv();
  const key = `cwe043-draft-${Math.random()}`;
  const req = await request('council-a.test', '/api/council/sessions', {
    method: 'POST',
    csrf: true,
    idempotencyKey: key,
    body: { ...draftBody(visibility, question), idempotency_key: key },
  });
  const response = await sessionsRoute.POST(req);
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data.spec.session_id as string;
}

async function getSession(
  host: Host,
  subject: string | null,
  id: string,
  extra: { cookieOverride?: string; suffix?: string } = {},
): Promise<{ status: number; body: any }> {
  installFixtureEnv();
  const req = await request(host, `/api/council/sessions/${id}${extra.suffix ?? ''}`, {
    subject,
    cookieOverride: extra.cookieOverride,
  });
  const response = await sessionRoute.GET(req, { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
}

async function getEvents(
  host: Host,
  subject: string | null,
  id: string,
  suffix = '',
): Promise<{ status: number; body: any }> {
  installFixtureEnv();
  const req = await request(host, `/api/council/sessions/${id}/events${suffix}`, { subject });
  const response = await eventsRoute.GET(req, { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
}

test('cross-tenant, cross-company, and guessed-ID reads are one indistinguishable not-found', async () => {
  const id = await createDraft('company');
  const owner = await getSession('council-a.test', ALICE, id);
  assert.equal(owner.status, 200, JSON.stringify(owner.body));

  const crossTenant = await getSession('council-b.test', ALICE, id);
  const crossCompany = await getSession('council-a2.test', ALICE, id);
  const guessed = await getSession(
    'council-a.test',
    ALICE,
    '00000000-0000-4000-8000-000000000000',
  );
  for (const probe of [crossTenant, crossCompany, guessed]) {
    assert.equal(probe.status, 404, JSON.stringify(probe.body));
    assert.equal(probe.body.error.code, 'PERSISTENCE_SESSION_NOT_FOUND');
  }
  assert.deepEqual(
    { status: crossTenant.status, code: crossTenant.body.error.code },
    { status: guessed.status, code: guessed.body.error.code },
    'a foreign session and a nonexistent session answer identically: no existence oracle',
  );
  const serialized = JSON.stringify(crossTenant.body) + JSON.stringify(crossCompany.body);
  assert.ok(!serialized.includes('pilot'), 'no session content leaks in a denial');
});

test('a private session denies the same-company non-owner on both the session and events surfaces', async () => {
  const id = await createDraft('private', PRIVATE_MARKER);
  const bobRead = await getSession('council-a.test', BOB, id);
  assert.notEqual(bobRead.status, 200, JSON.stringify(bobRead.body));
  assert.ok(
    !JSON.stringify(bobRead.body).includes(PRIVATE_MARKER),
    'the private question text never appears in a denial',
  );
  const bobEvents = await getEvents('council-a.test', BOB, id);
  assert.equal(bobEvents.status, 403, JSON.stringify(bobEvents.body));
  assert.equal(bobEvents.body.error.code, 'COUNCIL_PRIVATE_OWNER_REQUIRED');
  assert.ok(
    !JSON.stringify(bobEvents.body).includes(PRIVATE_MARKER),
    'no private content rides the events denial',
  );
  const noAuth = await getSession('council-a.test', null, id);
  assert.notEqual(noAuth.status, 200);
});

test('a cursor earned in one scope replays nothing in another scope', async () => {
  const id = await createDraft('company');
  const page = await getEvents('council-a.test', ALICE, id);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.data.kind, 'page');
  assert.ok(page.body.data.page.events.length >= 1);
  const cursor = page.body.data.page.events[0].sequence as number;

  const foreign = await getEvents('council-b.test', ALICE, id, `?after=${cursor}`);
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  const foreignCompany = await getEvents('council-a2.test', ALICE, id, `?after=${cursor}`);
  assert.equal(foreignCompany.status, 404);
  const foreignBody = JSON.stringify(foreign.body) + JSON.stringify(foreignCompany.body);
  assert.ok(!foreignBody.includes('session_created'), 'no event content crosses scopes via a replayed cursor');

  // The same cursor in the owning scope is a legal, exact catch-up.
  const own = await getEvents('council-a.test', ALICE, id, `?after=${cursor}`);
  assert.equal(own.status, 200, JSON.stringify(own.body));
});

test('stale cookies and host-swapped credentials fail closed', async () => {
  const id = await createDraft('company');
  const expired = await grantCookie('council-a.test', ALICE, -60);
  const stale = await getSession('council-a.test', ALICE, id, { cookieOverride: expired });
  assert.notEqual(stale.status, 200, 'an expired grant is not a session');
  assert.ok(!JSON.stringify(stale.body).includes('spec'), 'no session payload on a stale cookie');

  // A grant minted for tenant A presented to tenant B's host: the
  // host binding and the grant disagree, so it must not authenticate
  // as anyone.
  const foreignCookie = await grantCookie('council-a.test', ALICE);
  const swapped = await getSession('council-b.test', ALICE, id, { cookieOverride: foreignCookie });
  assert.notEqual(swapped.status, 200, JSON.stringify(swapped.body));

  // A garbage cookie is equally closed.
  const garbage = await getSession('council-a.test', ALICE, id, {
    cookieOverride: 'mc_tenant_session=not-a-real-grant',
  });
  assert.notEqual(garbage.status, 200);
});

test('credentials in the query string are rejected, never honored', async () => {
  const id = await createDraft('company');
  // Every credential-shaped parameter name in the CWE-007 contract
  // set is refused outright, even alongside a valid session cookie.
  for (const name of ['token', 'api_key', 'access_token', 'secret', 'password']) {
    const probe = await getSession('council-a.test', ALICE, id, {
      suffix: `?${name}=${OPERATOR_TOKEN}`,
    });
    assert.equal(probe.status, 400, `${name} answered ${probe.status}`);
    assert.equal(probe.body.error.code, 'COUNCIL_QUERY_CREDENTIAL');
  }
  // And a query credential on its own never authenticates anyone,
  // including spellings outside the rejection set.
  const noCookie = await getSession('council-a.test', null, id, {
    suffix: `?token=${OPERATOR_TOKEN}`,
  });
  assert.notEqual(noCookie.status, 200, 'a query credential never authenticates a request');
  const unlisted = await getSession('council-a.test', null, id, {
    suffix: `?api_token=${OPERATOR_TOKEN}`,
  });
  assert.notEqual(unlisted.status, 200, 'an unlisted credential spelling is ignored, never honored');
});

test('a denied mutation changes nothing: no-CSRF start and cross-tenant cancel', async () => {
  const id = await createDraft('company');

  const key = `cwe043-start-${Math.random()}`;
  const noCsrfReq = await request('council-a.test', `/api/council/sessions/${id}/start`, {
    method: 'POST',
    idempotencyKey: key,
    body: { idempotency_key: key },
  });
  const noCsrf = await startRoute.POST(noCsrfReq, { params: Promise.resolve({ id }) });
  assert.equal(noCsrf.status, 403, 'a mutation without CSRF proof is refused');
  let state = await getSession('council-a.test', ALICE, id);
  assert.equal(state.body.data.state.state, 'DRAFT');

  const cancelKey = `cwe043-cancel-${Math.random()}`;
  const foreignReq = await request('council-b.test', `/api/council/sessions/${id}/cancel`, {
    method: 'POST',
    csrf: true,
    idempotencyKey: cancelKey,
    body: { idempotency_key: cancelKey },
  });
  const foreignCancel = await cancelRoute.POST(foreignReq, { params: Promise.resolve({ id }) });
  assert.equal(foreignCancel.status, 404, JSON.stringify(await foreignCancel.clone().json().catch(() => ({}))));
  state = await getSession('council-a.test', ALICE, id);
  assert.equal(state.body.data.state.state, 'DRAFT', 'the foreign cancel did not move the session');
  const jobs = db
    .prepare('SELECT COUNT(*) AS n FROM council_jobs WHERE session_id = ?')
    .get(id) as { n: number };
  assert.equal(jobs.n, 0, 'no durable job was created by any denied mutation');
});

test('export downloads: guessed, foreign, and traversal IDs are all the same typed not-found', async () => {
  const guessed = `export-${Math.random().toString(36).slice(2)}`;
  installFixtureEnv();
  const ownReq = await request('council-a.test', `/api/council/exports/${guessed}`);
  const ownRes = await exportRoute.GET(ownReq, { params: Promise.resolve({ exportId: guessed }) });
  const ownBody = await ownRes.json();
  assert.equal(ownRes.status, 404, JSON.stringify(ownBody));

  const foreignReq = await request('council-b.test', `/api/council/exports/${guessed}`);
  const foreignRes = await exportRoute.GET(foreignReq, { params: Promise.resolve({ exportId: guessed }) });
  assert.equal(foreignRes.status, 404);

  for (const evil of ['..%2F..%2Fetc%2Fpasswd', '../../etc/passwd', '..\\\\..\\\\windows\\\\win.ini', '/etc/passwd', 'export-1/../../secret']) {
    const req = await request('council-a.test', `/api/council/exports/${evil}`);
    const res = await exportRoute.GET(req, { params: Promise.resolve({ exportId: evil }) });
    const text = await res.text();
    assert.equal(res.status, 404, `traversal export id ${evil} answered ${res.status}`);
    assert.ok(!text.includes('root:'), 'no filesystem content is ever served');
  }
});
