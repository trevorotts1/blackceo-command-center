/**
 * council-api-routes.test.ts — CWE-029 API foundation routes
 * (src/app/api/council/** over src/lib/council/api/**), directive
 * Sections 17.1, 17.2, 17.3, 17.5, 17.6.
 *
 * Route handlers are invoked directly with NextRequest fixtures whose
 * identity comes from the REAL tenant context (signed session grants,
 * the CWE-007 pattern) and whose writes land in the REAL CWE-006
 * store over an isolated database. Fixture identities are synthetic
 * and labeled as such; no real tenant data exists in this file.
 *
 * Covers:
 *   1. Real round trip: create a draft via POST /sessions, read it
 *      back via GET /sessions/:id, byte-equal; brief PATCH under
 *      expected revision, then read back; journal chain verifies.
 *   2. Idempotency: replay returns the original draft, a conflicting
 *      payload returns 409, a missing key fails validation.
 *   3. Authorization negatives: unauthenticated 403, cross-tenant and
 *      cross-company reads answer the typed not-found, private read
 *      by a same-company non-owner is denied, support reads succeed
 *      as auditable via-support while support mutation is denied,
 *      conflicting body/query scope is rejected, query credentials
 *      are rejected, missing auth configuration fails closed as a
 *      503 readiness error, missing CSRF proof is rejected.
 *   4. FEATURE_NOT_READY shape on every unwired endpoint: typed code,
 *      owning unit named, no success payload, no real-looking IDs,
 *      and the target session's committed state is unchanged.
 *   5. Not-found honesty and the explicit not-ready verdict state.
 *   6. Metadata reads: capabilities, advisors, models.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-api-routes.test.ts
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

const SESSION_SECRET = 'cwe029-fixture-session-secret';
const OPERATOR_TOKEN = 'cwe029-fixture-operator-token';
const CSRF_SECRET = 'cwe029-fixture-csrf-secret';

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

let sessionsRoute: { GET: RouteHandler; POST: RouteHandler };
let sessionRoute: { GET: RouteHandler; DELETE: RouteHandler };
let briefRoute: { PATCH: RouteHandler };
let verdictRoute: { GET: RouteHandler };
let capabilitiesRoute: { GET: RouteHandler };
let advisorsRoute: { GET: RouteHandler };
let modelsRoute: { GET: RouteHandler };
let probeRoute: { POST: RouteHandler };
let eventsRoute: { GET: RouteHandler };
let evidenceRoute: { GET: RouteHandler };
let settingsRoute: { GET: RouteHandler; PATCH: RouteHandler };
let exportsRoute: { POST: RouteHandler };
let exportRoute: { GET: RouteHandler };
let runAuthRoute: { GET: RouteHandler };
let canonicalStringifyFn: typeof import('../../src/lib/council/contracts').canonicalStringify;
let closeDbFn: () => void;
const notReadyRoutes: Record<string, { handler: RouteHandler; owner: string; sessionScoped: boolean }> = {};

before(async () => {
  sessionsRoute = await import('../../src/app/api/council/sessions/route');
  sessionRoute = await import('../../src/app/api/council/sessions/[id]/route');
  briefRoute = await import('../../src/app/api/council/sessions/[id]/brief/route');
  verdictRoute = await import('../../src/app/api/council/sessions/[id]/verdict/route');
  capabilitiesRoute = await import('../../src/app/api/council/capabilities/route');
  advisorsRoute = await import('../../src/app/api/council/advisors/route');
  modelsRoute = await import('../../src/app/api/council/models/route');
  probeRoute = await import('../../src/app/api/council/models/probe/route');
  eventsRoute = await import('../../src/app/api/council/sessions/[id]/events/route');
  evidenceRoute = await import('../../src/app/api/council/sessions/[id]/evidence/[evidenceId]/route');
  settingsRoute = await import('../../src/app/api/council/settings/route');
  exportsRoute = await import('../../src/app/api/council/exports/route');
  exportRoute = await import('../../src/app/api/council/exports/[exportId]/route');
  runAuthRoute = await import('../../src/app/api/council/sessions/[id]/run-authorization/route');
  const sessionScoped: Array<[string, string, string]> = [
    ['start', 'council.sessions.start', 'CWE-027'],
    ['pause', 'council.sessions.pause', 'CWE-027'],
    ['cancel', 'council.sessions.cancel', 'CWE-027'],
    ['resume', 'council.sessions.resume', 'CWE-027'],
    ['decision', 'council.sessions.decision', 'CWE-050'],
    ['follow-up', 'council.sessions.follow_up', 'CWE-050'],
    ['rerun', 'council.sessions.rerun', 'CWE-050'],
    ['outcomes', 'council.sessions.outcomes', 'CWE-050'],
    ['archive', 'council.sessions.archive', 'CWE-050'],
    ['action-plan/preview', 'council.sessions.action_plan.preview', 'CWE-036'],
    ['action-plan/approve', 'council.sessions.action_plan.approve', 'CWE-036'],
    ['action-plan/create', 'council.sessions.action_plan.create', 'CWE-036'],
    ['run-authorization/preview', 'council.sessions.run_authorization.preview', 'CWE-049'],
    ['run-authorization/approve', 'council.sessions.run_authorization.approve', 'CWE-049'],
    ['run-authorization/revoke', 'council.sessions.run_authorization.revoke', 'CWE-049'],
  ];
  for (const [segment, , owner] of sessionScoped) {
    const mod = await import(`../../src/app/api/council/sessions/[id]/${segment}/route`);
    notReadyRoutes[segment] = { handler: mod.POST as RouteHandler, owner, sessionScoped: true };
  }
  const contracts = await import('../../src/lib/council/contracts');
  canonicalStringifyFn = contracts.canonicalStringify;
  const dbModule = await import('../../src/lib/db');
  closeDbFn = dbModule.closeDb;
});

after(() => {
  closeDbFn();
});

async function makeRequest(
  host: Host,
  subject: string | null,
  path: string,
  options: { method?: string; body?: unknown; csrf?: boolean; idempotencyKey?: string } = {},
): Promise<NextRequest> {
  const headers: Record<string, string> = { host };
  const cookies: string[] = [];
  if (subject !== null) {
    const reg = HOSTS[host];
    const token = await signTenantGrant({
      purpose: 'session',
      tenantId: reg.tenantId,
      companyId: reg.companyId,
      subject,
      host,
      installationId: reg.installationId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: `fixture-${subject}-${Math.random()}`,
    });
    cookies.push(`mc_tenant_session=${token}`);
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

function draftBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'selected',
    visibility: 'private',
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
      question: 'Should we pilot the revised offer before a broad launch?',
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
    ...overrides,
  };
}

async function createDraft(
  subject = 'owner:alice',
  overrides: Record<string, unknown> = {},
  key = `create-${Math.random()}`,
): Promise<{ status: number; body: any }> {
  installFixtureEnv();
  const request = await makeRequest('council-a.test', subject, '/api/council/sessions', {
    method: 'POST',
    csrf: true,
    idempotencyKey: key,
    body: draftBody(overrides),
  });
  const response = await sessionsRoute.POST(request);
  return { status: response.status, body: await response.json() };
}

async function getSession(
  id: string,
  subject: string | null = 'owner:alice',
  host: Host = 'council-a.test',
  pathSuffix = '',
): Promise<{ status: number; body: any }> {
  const request = await makeRequest(host, subject, `/api/council/sessions/${id}${pathSuffix}`);
  const response = await sessionRoute.GET(request, { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
}

test('round trip: draft created via the route reads back byte-equal via the read route', async () => {
  const created = await createDraft();
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.ok, true);
  const session = created.body.data;
  assert.match(session.spec.session_id, /^[0-9a-f-]{36}$/);
  assert.equal(session.state.state, 'DRAFT');
  assert.equal(session.state.state_version, 0);
  assert.equal(session.brief.revision, 1);
  assert.equal(session.scope.owner_subject, 'owner:alice');
  assert.equal(session.scope.tenant_id, 'tenant-a');
  assert.equal(session.sample, false);

  const read = await getSession(session.spec.session_id);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.meta.access_via, 'owner');
  assert.equal(
    canonicalStringifyFn(read.body.data),
    canonicalStringifyFn(session),
    'the read route returns exactly the committed draft, byte-equal',
  );
});

test('list returns committed sessions in scope with visibility filtering', async () => {
  const mine = await createDraft('owner:alice');
  const shared = await createDraft('owner:alice', { visibility: 'company' });
  assert.equal(mine.status, 201);
  assert.equal(shared.status, 201);

  const asAlice = await sessionsRoute.GET(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/sessions'),
  );
  const aliceBody = await asAlice.json();
  assert.equal(asAlice.status, 200);
  const aliceIds = aliceBody.data.sessions.map((s: any) => s.session_id);
  assert.ok(aliceIds.includes(mine.body.data.spec.session_id));
  assert.ok(aliceIds.includes(shared.body.data.spec.session_id));

  const asBob = await sessionsRoute.GET(
    await makeRequest('council-a.test', 'owner:bob', '/api/council/sessions'),
  );
  const bobBody = await asBob.json();
  const bobIds = bobBody.data.sessions.map((s: any) => s.session_id);
  assert.ok(!bobIds.includes(mine.body.data.spec.session_id), 'private draft hidden from bob');
  assert.ok(bobIds.includes(shared.body.data.spec.session_id), 'company draft visible to bob');
});

test('brief PATCH revises under expected revision and the journal chain verifies', async () => {
  const created = await createDraft();
  const id = created.body.data.spec.session_id;
  const patch = await briefRoute.PATCH(
    await makeRequest('council-a.test', 'owner:alice', `/api/council/sessions/${id}/brief`, {
      method: 'PATCH',
      csrf: true,
      idempotencyKey: 'brief-patch-1',
      body: {
        expected_revision: 1,
        brief: {
          question: 'Should we pilot the revised offer in one region first?',
          options: [
            { id: 'A', label: 'Keep the current offer', kind: 'status_quo' },
            { id: 'B', label: 'Pilot the revised offer', kind: 'bounded_test' },
          ],
        },
      },
    }),
    { params: Promise.resolve({ id }) },
  );
  const patchBody = await patch.json();
  assert.equal(patch.status, 200, JSON.stringify(patchBody));
  assert.equal(patchBody.data.brief.revision, 2);
  assert.equal(patchBody.data.brief.question, 'Should we pilot the revised offer in one region first?');

  const read = await getSession(id);
  assert.equal(read.body.data.brief.revision, 2);
  assert.equal(read.body.data.brief.question, 'Should we pilot the revised offer in one region first?');

  const storeModule = await import('../../src/lib/council/store');
  const repositories = storeModule.openCouncilRepositories();
  const envelope = storeModule.envelopeFromScope(
    read.body.data.scope,
    'owner:alice',
    'owner',
    'read',
  );
  const chain = repositories.verifyChain(envelope, id);
  assert.equal(chain.ok, true, JSON.stringify(chain));
  const events = repositories.listEvents(envelope, id);
  assert.deepEqual(events.map((e) => e.type), ['session_created', 'brief_revised']);
});

test('brief PATCH with a stale expected revision returns VERSION_MISMATCH and writes nothing', async () => {
  const created = await createDraft();
  const id = created.body.data.spec.session_id;
  const patch = await briefRoute.PATCH(
    await makeRequest('council-a.test', 'owner:alice', `/api/council/sessions/${id}/brief`, {
      method: 'PATCH',
      csrf: true,
      idempotencyKey: 'brief-patch-stale',
      body: {
        expected_revision: 7,
        brief: {
          question: 'A different question entirely?',
          options: [{ id: 'A', label: 'Only option', kind: 'other' }],
        },
      },
    }),
    { params: Promise.resolve({ id }) },
  );
  const body = await patch.json();
  assert.equal(patch.status, 409);
  assert.equal(body.error.code, 'VERSION_MISMATCH');
  const read = await getSession(id);
  assert.equal(read.body.data.brief.revision, 1);
  assert.equal(read.body.data.brief.question, 'Should we pilot the revised offer before a broad launch?');
});

test('idempotency: replay returns the original draft; a different payload conflicts; a missing key fails', async () => {
  const first = await createDraft('owner:alice', {}, 'idem-key-1');
  assert.equal(first.status, 201);
  const replay = await createDraft('owner:alice', {}, 'idem-key-1');
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.meta.replayed, true);
  assert.equal(replay.body.data.spec.session_id, first.body.data.spec.session_id);

  const conflict = await createDraft(
    'owner:alice',
    { brief: { question: 'Changed question?', options: [{ id: 'A', label: 'X', kind: 'other' }] } },
    'idem-key-1',
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  installFixtureEnv();
  const noKey = await sessionsRoute.POST(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/sessions', {
      method: 'POST',
      csrf: true,
      body: draftBody(),
    }),
  );
  const noKeyBody = await noKey.json();
  assert.equal(noKey.status, 400);
  assert.equal(noKeyBody.error.code, 'SCHEMA_VALIDATION');
});

test('authorization negatives: unauthenticated, cross-tenant, cross-company, private non-owner', async () => {
  const created = await createDraft();
  const id = created.body.data.spec.session_id;

  const anon = await getSession(id, null);
  assert.equal(anon.status, 403);
  assert.equal(anon.body.error.code, 'COUNCIL_UNAUTHENTICATED');

  const crossTenant = await getSession(id, 'owner:alice', 'council-b.test');
  assert.equal(crossTenant.status, 404);
  assert.equal(crossTenant.body.error.code, 'PERSISTENCE_SESSION_NOT_FOUND');

  const crossCompany = await getSession(id, 'owner:alice', 'council-a2.test');
  assert.equal(crossCompany.status, 404);
  assert.equal(crossCompany.body.error.code, 'PERSISTENCE_SESSION_NOT_FOUND');

  const nonOwner = await getSession(id, 'owner:bob');
  assert.equal(nonOwner.status, 403);
  assert.equal(nonOwner.body.error.code, 'COUNCIL_PRIVATE_OWNER_REQUIRED');
});

test('support read is auditable via-support; support mutation is denied', async () => {
  const created = await createDraft();
  const id = created.body.data.spec.session_id;
  process.env.MC_COUNCIL_SUPPORT_SUBJECTS = 'support:desk';
  try {
    const supportRead = await getSession(id, 'support:desk');
    assert.equal(supportRead.status, 200, JSON.stringify(supportRead.body));
    assert.equal(supportRead.body.meta.access_via, 'support');

    const supportPatch = await briefRoute.PATCH(
      await makeRequest('council-a.test', 'support:desk', `/api/council/sessions/${id}/brief`, {
        method: 'PATCH',
        csrf: true,
        idempotencyKey: 'support-patch',
        body: {
          expected_revision: 1,
          brief: { question: 'Support must not write this.', options: [{ id: 'A', label: 'X', kind: 'other' }] },
        },
      }),
      { params: Promise.resolve({ id }) },
    );
    const supportPatchBody = await supportPatch.json();
    assert.equal(supportPatch.status, 403);
    assert.equal(supportPatchBody.error.code, 'COUNCIL_PRIVATE_OWNER_REQUIRED');
  } finally {
    delete process.env.MC_COUNCIL_SUPPORT_SUBJECTS;
  }
});

test('conflicting body scope, conflicting query scope, and query credentials are rejected', async () => {
  installFixtureEnv();
  const bodyConflict = await sessionsRoute.POST(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/sessions', {
      method: 'POST',
      csrf: true,
      idempotencyKey: 'scope-conflict',
      body: draftBody({ company_id: 'company-b' }),
    }),
  );
  const bodyConflictBody = await bodyConflict.json();
  assert.equal(bodyConflict.status, 403);
  assert.equal(bodyConflictBody.error.code, 'COUNCIL_SCOPE_MISMATCH');

  const created = await createDraft();
  const id = created.body.data.spec.session_id;
  const queryConflict = await getSession(id, 'owner:alice', 'council-a.test', '?tenant_id=tenant-b');
  assert.equal(queryConflict.status, 403);
  assert.equal(queryConflict.body.error.code, 'COUNCIL_SCOPE_MISMATCH');

  const credential = await sessionsRoute.GET(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/sessions?api_key=fixture-value'),
  );
  const credentialBody = await credential.json();
  assert.equal(credential.status, 400);
  assert.equal(credentialBody.error.code, 'COUNCIL_QUERY_CREDENTIAL');
  assert.ok(!JSON.stringify(credentialBody).includes('fixture-value'), 'the credential value is never echoed');
});

test('missing CSRF proof on a mutation is rejected', async () => {
  installFixtureEnv();
  const response = await sessionsRoute.POST(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/sessions', {
      method: 'POST',
      idempotencyKey: 'no-csrf',
      body: draftBody(),
    }),
  );
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'COUNCIL_CSRF_REQUIRED');
});

test('missing auth configuration fails closed as a 503 readiness error', async () => {
  const created = await createDraft();
  const id = created.body.data.spec.session_id;
  const request = await makeRequest(
    'council-a.test',
    'owner:alice',
    `/api/council/sessions/${id}`,
  );
  process.env.MC_TENANT_REGISTRY_JSON = '{}';
  delete process.env.MC_TENANT_SESSION_SECRET;
  delete process.env.MC_API_TOKEN;
  try {
    const response = await sessionRoute.GET(request, { params: Promise.resolve({ id }) });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error.code, 'COUNCIL_AUTH_NOT_CONFIGURED');
  } finally {
    installFixtureEnv();
  }
});

test('not-found honesty: a missing session returns the typed not-found and no fabricated object', async () => {
  installFixtureEnv();
  const missing = await getSession('123e4567-e89b-42d3-a456-426614174000');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.error.code, 'PERSISTENCE_SESSION_NOT_FOUND');
  assert.equal(missing.body.data, undefined);
});

test('verdict read on a fresh draft returns the explicit not-ready state', async () => {
  const created = await createDraft();
  const id = created.body.data.spec.session_id;
  const response = await verdictRoute.GET(
    await makeRequest('council-a.test', 'owner:alice', `/api/council/sessions/${id}/verdict`),
    { params: Promise.resolve({ id }) },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.verdict_state, 'not_ready');
  assert.equal(body.data.verdict, null);
});

test('verdict read returns a committed verdict verbatim (validated branch)', async () => {
  const created = await createDraft();
  const id = created.body.data.spec.session_id;
  const storeModule = await import('../../src/lib/council/store');
  const contracts = await import('../../src/lib/council/contracts');
  const repositories = storeModule.openCouncilRepositories();
  const envelope = storeModule.envelopeFromScope(
    created.body.data.scope,
    'owner:alice',
    'owner',
    'write',
  );
  const base = {
    schema_version: contracts.SCHEMA_VERSIONS.verdict,
    result_kind: 'scored' as const,
    session_id: id,
    verdict_revision: 1,
    recommended_option_id: 'B',
    label: 'WAIT' as const,
    option_scores: [],
    active_weights: {},
    evidence_strength: 'medium' as const,
    hard_constraint_findings: [],
    main_reasons: ['Fixture reason.'],
    strongest_dissent: null,
    accepted_amendments: [],
    rejected_amendments: [],
    critical_unknowns: [],
    prerequisites: [],
    action_proposals: [],
    cheapest_informative_test: null,
    stop_criteria: [],
    review_criteria: [],
    resolution_support: null,
    validation_status: 'valid' as const,
    ratification_status: 'ratified' as const,
    brief_sha256: created.body.data.spec.brief_sha256,
  };
  const verdict = { ...base, content_sha256: contracts.canonicalHash(base) };
  const saved = repositories.saveVerdict(envelope, verdict as never);
  assert.equal(saved.outcome, 'committed');

  const response = await verdictRoute.GET(
    await makeRequest('council-a.test', 'owner:alice', `/api/council/sessions/${id}/verdict`),
    { params: Promise.resolve({ id }) },
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.verdict_state, 'validated');
  assert.equal(body.data.verdict.content_sha256, verdict.content_sha256);
  assert.equal(body.data.verdict.label, 'WAIT');
});

test('validation failures are canonical SCHEMA_VALIDATION, never a stored draft', async () => {
  installFixtureEnv();
  const badSeat = await createDraft('owner:alice', { seat_ids: ['not-a-seat', 'brene-brown'] });
  assert.equal(badSeat.status, 400);
  assert.equal(badSeat.body.error.code, 'SCHEMA_VALIDATION');
  const badBrief = await sessionsRoute.POST(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/sessions', {
      method: 'POST',
      csrf: true,
      idempotencyKey: 'bad-brief',
      body: draftBody({ brief: { question: 'No options at all?' } }),
    }),
  );
  assert.equal(badBrief.status, 400);
  assert.equal((await badBrief.json()).error.code, 'SCHEMA_VALIDATION');
});

test('metadata reads: capabilities, advisors, models', async () => {
  installFixtureEnv();
  const capabilities = await capabilitiesRoute.GET(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/capabilities'),
  );
  const capabilitiesBody = await capabilities.json();
  assert.equal(capabilities.status, 200, JSON.stringify(capabilitiesBody));
  assert.equal(capabilitiesBody.data.foundation.unit, 'CWE-029');
  assert.equal(capabilitiesBody.data.endpoints.total, 32);
  assert.equal(capabilitiesBody.data.endpoints.ready, 8);
  assert.equal(capabilitiesBody.data.principal.subject, 'owner:alice');

  const advisors = await advisorsRoute.GET(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/advisors'),
  );
  const advisorsBody = await advisors.json();
  assert.equal(advisors.status, 200);
  assert.equal(advisorsBody.data.seats.length, 9);
  for (const seat of advisorsBody.data.seats) {
    assert.match(seat.profile_label, /Not the individual and not an endorsement/);
    assert.equal(seat.provenance, 'canonical_contract');
  }

  const models = await modelsRoute.GET(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/models'),
  );
  const modelsBody = await models.json();
  assert.equal(models.status, 200, JSON.stringify(modelsBody));
  assert.equal(modelsBody.data.summary.runtime_verified, false);
  assert.ok(Array.isArray(modelsBody.data.routes));
  for (const route of modelsBody.data.routes) {
    assert.ok(['UNTESTED', 'PROBED', 'QUALIFIED'].includes(route.readiness));
    assert.ok(!('value' in route.credential), 'credential values never appear');
  }
});

test('FEATURE_NOT_READY shape on every unwired endpoint; committed state unchanged', async () => {
  const created = await createDraft('owner:alice', { visibility: 'company' });
  const id = created.body.data.spec.session_id;

  const checkNotReady = async (
    label: string,
    response: Response,
    owner: string,
  ): Promise<void> => {
    const body = await response.json();
    assert.equal(response.status, 501, `${label}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, false, label);
    assert.equal(body.error.code, 'FEATURE_NOT_READY', label);
    assert.match(body.error.message, new RegExp(owner), label);
    assert.equal(body.data, undefined, label);
    const serialized = JSON.stringify(body).replace(/request_id/g, '');
    assert.ok(!/session_id|export_id|task_id|grant_id/.test(serialized), label);
  };

  for (const [segment, route] of Object.entries(notReadyRoutes)) {
    installFixtureEnv();
    const response = await route.handler(
      await makeRequest('council-a.test', 'owner:alice', `/api/council/sessions/${id}/${segment}`, {
        method: 'POST',
        csrf: true,
        idempotencyKey: `nr-${segment}`,
        body: {},
      }),
      { params: Promise.resolve({ id }) },
    );
    await checkNotReady(segment, response, route.owner);
  }

  installFixtureEnv();
  await checkNotReady('session delete', await sessionRoute.DELETE(
    await makeRequest('council-a.test', 'owner:alice', `/api/council/sessions/${id}`, {
      method: 'DELETE',
      csrf: true,
      idempotencyKey: 'nr-delete',
    }),
    { params: Promise.resolve({ id }) },
  ), 'CWE-050');
  await checkNotReady('models probe', await probeRoute.POST(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/models/probe', {
      method: 'POST',
      csrf: true,
      idempotencyKey: 'nr-probe',
      body: {},
    }),
  ), 'CWE-009');
  await checkNotReady('exports create', await exportsRoute.POST(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/exports', {
      method: 'POST',
      csrf: true,
      idempotencyKey: 'nr-export',
      body: {},
    }),
  ), 'CWE-038');
  await checkNotReady('export get', await exportRoute.GET(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/exports/some-export'),
  ), 'CWE-038');
  await checkNotReady('settings get', await settingsRoute.GET(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/settings'),
  ), 'CWE-050');
  await checkNotReady('settings patch', await settingsRoute.PATCH(
    await makeRequest('council-a.test', 'owner:alice', '/api/council/settings', {
      method: 'PATCH',
      csrf: true,
      idempotencyKey: 'nr-settings',
      body: {},
    }),
  ), 'CWE-050');
  await checkNotReady('events get', await eventsRoute.GET(
    await makeRequest('council-a.test', 'owner:alice', `/api/council/sessions/${id}/events`),
    { params: Promise.resolve({ id }) },
  ), 'CWE-030');
  await checkNotReady('evidence get', await evidenceRoute.GET(
    await makeRequest('council-a.test', 'owner:alice', `/api/council/sessions/${id}/evidence/ev-1`),
    { params: Promise.resolve({ id, evidenceId: 'ev-1' }) },
  ), 'CWE-025');
  await checkNotReady('run-authorization get', await runAuthRoute.GET(
    await makeRequest('council-a.test', 'owner:alice', `/api/council/sessions/${id}/run-authorization`),
    { params: Promise.resolve({ id }) },
  ), 'CWE-049');

  const after = await getSession(id);
  assert.equal(after.status, 200);
  assert.equal(after.body.data.state.state, 'DRAFT');
  assert.equal(after.body.data.state.state_version, 0, 'no unwired endpoint moved the session');
});
