/**
 * CWE-045 tests: council.models.probe graduation (CWE-050 remainder).
 *
 * The probe route answers REAL composed behavior: it resolves the
 * route against the CWE-008 catalog, requires a purpose-bound
 * capability_probe run grant (CWE-049) pinned to that route, admits
 * exactly one provider operation against the grant, dispatches one
 * bounded request through the host connector's chat transport, and
 * records typed route evidence that the models catalog then reports.
 * The transport target is a loopback fixture server standing in for
 * the local-endpoint connector; no live provider is contacted.
 *
 * Run with:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-cwe045-probe.test.ts
 */
import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';
import { signCsrfToken } from '../../src/lib/csrf-protection';

const MODEL_ID = 'council-probe-fixture';
const OTHER_MODEL_ID = 'council-probe-other';
const SESSION_ID = 'sess-probe-1';
const SCOPE = {
  tenant_id: 'tenant-a',
  company_id: 'company-a',
  installation_id: 'install-a',
  owner_subject: 'owner-1',
};

let server: Server;
let serverHits = 0;
let serverMode: 'ok' | 'http500' = 'ok';

const savedEnv: Record<string, string | undefined> = {};
for (const key of ['MC_TENANT_REGISTRY_JSON', 'MC_TENANT_SESSION_SECRET', 'MC_API_TOKEN', 'MC_CSRF_COOKIE_SECRET', 'OLLAMA_LOCAL_HOST']) {
  savedEnv[key] = process.env[key];
}

let probeRoute: { POST: (request: NextRequest) => Promise<Response> };
let modelsRoute: { GET: (request: NextRequest) => Promise<Response> };
let serviceClass: typeof import('../../src/lib/council/run-authorization').CouncilRunAuthorizationService;
let openCouncilStoreFn: typeof import('../../src/lib/council/persistence/council-store').openCouncilStore;
let getDbFn: typeof import('../../src/lib/db').getDb;

function ownerPrincipal() {
  return {
    subject: 'owner-1',
    tenantKind: 'self',
    channel: 'browser',
    supportAccess: false,
    scope: { ...SCOPE, owner_subject: null },
    tenant: {
      subject: 'owner-1',
      companyId: SCOPE.company_id,
      tenantId: SCOPE.tenant_id,
      installationId: SCOPE.installation_id,
    },
  } as unknown as import('../../src/lib/council/auth').CouncilPrincipal;
}

function routeSnapshot(modelId: string) {
  return {
    schema: 'wise-elders.route-selection/v1',
    selectionSource: 'explicit',
    routeId: modelId,
    routeRevision: 1,
    routeKind: 'fixed_model',
    providerSlug: 'ollama-local',
    requestedRoute: modelId,
    requestedModelOrAlias: modelId,
    combinationMembers: null,
    reasoning: { requested: null, applied: null, supported: null, limitation: null },
    fallbackPolicy: 'none',
    providerAccountRef: null,
    capabilitySnapshot: {
      contextWindowTokens: 8192,
      maxOutputTokens: 1024,
      capabilities: ['text'],
      supportedReasoningLevels: null,
    },
    credential: { state: 'not_required', envVar: null, source: null, checked: [] },
    identityLevel: 'configured',
    scope: {
      tenantId: SCOPE.tenant_id,
      companyId: SCOPE.company_id,
      installationId: SCOPE.installation_id,
      ownerSubject: SCOPE.owner_subject,
    },
    createdAt: '2026-10-14T12:00:00.000Z',
  } as unknown as import('../../src/lib/council/explicit-selection').CouncilRouteSelection;
}

function approveProbeGrant(modelId: string, purpose = 'capability_probe'): string {
  const service = new serviceClass({ store: openCouncilStoreFn(), now: () => new Date().toISOString(), newId: () => `probe-${Math.random().toString(36).slice(2)}` });
  const preview = service.previewRun(ownerPrincipal(), {
    session_id: SESSION_ID,
    purpose: purpose as never,
    route_snapshot: routeSnapshot(modelId),
    route_policy_sha256: 'b'.repeat(64),
    ceilings: {
      max_provider_requests: 50,
      max_output_repairs: 9,
      max_transport_retries: 8,
      max_input_tokens: null,
      max_output_tokens: null,
      max_money: { amount_minor: 100_000, currency: 'USD' },
    },
  });
  const grant = service.approveRun(ownerPrincipal(), preview.preview_id, {
    authority_mode: 'managed_principal',
  });
  return grant.grant_id;
}

async function makeRequest(path: string, options: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<NextRequest> {
  const headers: Record<string, string> = { host: 'council-a.test' };
  const token = await signTenantGrant({
    purpose: 'session',
    tenantId: 'tenant-a',
    companyId: 'company-a',
    subject: 'owner-1',
    host: 'council-a.test',
    installationId: 'install-a',
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: `probe-fixture-${Math.random()}`,
  });
  const csrf = await signCsrfToken();
  headers.cookie = `mc_tenant_session=${token}; mc_csrf_token=${csrf.value}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return new NextRequest(`https://council-a.test${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

before(async () => {
  server = createServer((request, response) => {
    serverHits += 1;
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      if (serverMode === 'http500') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'fixture failure' }));
        return;
      }
      const parsed = JSON.parse(raw || '{}');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-fixture',
          model: parsed.model,
          choices: [{ message: { role: 'assistant', content: 'ready' } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.OLLAMA_LOCAL_HOST = `http://127.0.0.1:${port}`;

  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', kind: 'self', installationId: 'install-a' },
  });
  process.env.MC_TENANT_SESSION_SECRET = 'cwe045-fixture-session-secret';
  process.env.MC_API_TOKEN = 'cwe045-fixture-operator-token';
  process.env.MC_CSRF_COOKIE_SECRET = 'cwe045-fixture-csrf-secret';

  probeRoute = await import('../../src/app/api/council/models/probe/route');
  modelsRoute = await import('../../src/app/api/council/models/route');
  const runAuth = await import('../../src/lib/council/run-authorization');
  serviceClass = runAuth.CouncilRunAuthorizationService;
  const adapter = await import('../../src/lib/council/persistence/council-store');
  openCouncilStoreFn = adapter.openCouncilStore;
  const dbModule = await import('../../src/lib/db');
  getDbFn = dbModule.getDb;

  const db = getDbFn();
  db.prepare(
    `INSERT INTO model_registry (model_id, label, provider, capabilities, status) VALUES (?, ?, 'ollama-local', '["text"]', 'active')`,
  ).run(MODEL_ID, 'Council Probe Fixture');
  db.prepare(
    `INSERT INTO model_registry (model_id, label, provider, capabilities, status) VALUES (?, ?, 'ollama-local', '["text"]', 'active')`,
  ).run(OTHER_MODEL_ID, 'Council Probe Other');

  const store = await import('../../src/lib/council/store');
  const contracts = await import('../../src/lib/council/contracts');
  const fixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  const repositories = new store.CouncilRepositories({ now: () => new Date().toISOString(), newId: () => `seed-${Math.random().toString(36).slice(2)}` });
  const spec = JSON.parse(JSON.stringify(fixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(fixtures.validBrief));
  spec.session_id = SESSION_ID;
  brief.session_id = SESSION_ID;
  spec.brief_sha256 = contracts.canonicalHash(brief);
  const state = {
    schema_version: 'wise-elders.session-state/v1',
    session_id: SESSION_ID,
    mode: spec.mode,
    state: 'DRAFT',
    state_version: 0,
    brief_revision: brief.revision,
    resume_phase: null,
    cancel_generation: 0,
    revocation_generation: 0,
    attempt: 1,
    lease_epoch: 0,
    archived: false,
    updated_at: spec.created_at,
  };
  repositories.createSession(store.envelopeFromScope(SCOPE, 'owner-1', 'owner', 'write'), {
    spec,
    brief,
    scope: SCOPE,
    state: state as never,
    sample: false,
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('probe end to end: grant-fenced dispatch records typed evidence the catalog reports', async () => {
  const grantId = approveProbeGrant(MODEL_ID);
  const response = await probeRoute.POST(
    await makeRequest('/api/council/models/probe', {
      method: 'POST',
      idempotencyKey: 'probe-e2e-1',
      body: { route_id: MODEL_ID, grant_id: grantId },
    }),
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.probe_outcome, 'answered');
  assert.equal(body.data.evidence.transportProbed, true);
  assert.equal(body.data.evidence.reportedModelId, MODEL_ID);
  assert.equal(body.data.evidence.evaluation, null, 'a probe never fabricates an evaluation');
  assert.equal(body.data.identity_level, 'reported_identity');
  assert.equal(body.data.readiness, 'PROBED');
  assert.equal(serverHits, 1, 'exactly one transport dispatch');

  const db = getDbFn();
  const reservations = db
    .prepare('SELECT COUNT(*) AS n FROM council_budget_reservations WHERE session_id = ?')
    .get(SESSION_ID) as { n: number };
  assert.equal(reservations.n, 1, 'exactly one budget reservation for the probe');
  const attempts = db
    .prepare('SELECT COUNT(*) AS n FROM council_provider_attempts WHERE session_id = ?')
    .get(SESSION_ID) as { n: number };
  assert.equal(attempts.n, 1, 'exactly one provider attempt recorded');

  const models = await modelsRoute.GET(await makeRequest('/api/council/models'));
  const modelsBody = await models.json();
  const route = modelsBody.data.routes.find((entry: { routeId: string }) => entry.routeId === MODEL_ID);
  assert.ok(route, 'catalog lists the probed route');
  assert.equal(route.readiness, 'PROBED', 'recorded probe evidence lifts the catalog route to PROBED');
  assert.equal(route.identityLevel, 'reported_identity');
});

test('probe replay: the same idempotency key returns the recorded result and dispatches nothing new', async () => {
  const grantId = approveProbeGrant(OTHER_MODEL_ID);
  const first = await probeRoute.POST(
    await makeRequest('/api/council/models/probe', {
      method: 'POST',
      idempotencyKey: 'probe-replay-1',
      body: { route_id: OTHER_MODEL_ID, grant_id: grantId },
    }),
  );
  assert.equal(first.status, 200);
  const hitsAfterFirst = serverHits;
  const replay = await probeRoute.POST(
    await makeRequest('/api/council/models/probe', {
      method: 'POST',
      idempotencyKey: 'probe-replay-1',
      body: { route_id: OTHER_MODEL_ID, grant_id: grantId },
    }),
  );
  const replayBody = await replay.json();
  assert.equal(replay.status, 200, JSON.stringify(replayBody));
  assert.equal(replayBody.meta.replayed, true);
  assert.equal(replayBody.data.replayed, true);
  assert.equal(serverHits, hitsAfterFirst, 'a replay dispatches no second probe');
});

test('probe refusals: purpose mismatch, route mismatch, unknown route', async () => {
  const hitsBefore = serverHits;
  const runGrantId = approveProbeGrant(MODEL_ID, 'council_run');
  const purpose = await probeRoute.POST(
    await makeRequest('/api/council/models/probe', {
      method: 'POST',
      idempotencyKey: 'probe-purpose-1',
      body: { route_id: MODEL_ID, grant_id: runGrantId },
    }),
  );
  const purposeBody = await purpose.json();
  assert.equal(purpose.status, 403, JSON.stringify(purposeBody));
  assert.equal(purposeBody.error.code, 'RUN_GRANT_PURPOSE_MISMATCH');

  const otherGrantId = approveProbeGrant(OTHER_MODEL_ID);
  const routeMismatch = await probeRoute.POST(
    await makeRequest('/api/council/models/probe', {
      method: 'POST',
      idempotencyKey: 'probe-route-1',
      body: { route_id: MODEL_ID, grant_id: otherGrantId },
    }),
  );
  const routeMismatchBody = await routeMismatch.json();
  assert.equal(routeMismatch.status, 403, JSON.stringify(routeMismatchBody));
  assert.equal(routeMismatchBody.error.code, 'RUN_GRANT_ROUTE_MISMATCH');

  const missing = await probeRoute.POST(
    await makeRequest('/api/council/models/probe', {
      method: 'POST',
      idempotencyKey: 'probe-missing-1',
      body: { route_id: 'no-such-model', grant_id: otherGrantId },
    }),
  );
  const missingBody = await missing.json();
  assert.equal(missing.status, 404, JSON.stringify(missingBody));
  assert.equal(missingBody.error.code, 'COUNCIL_ROUTE_NOT_FOUND');
  assert.equal(serverHits, hitsBefore, 'refusals dispatch nothing');
});

test('probe transport failure is recorded honestly: HTTP 500 reads failed, never answered', async () => {
  serverMode = 'http500';
  try {
    const grantId = approveProbeGrant(MODEL_ID);
    const response = await probeRoute.POST(
      await makeRequest('/api/council/models/probe', {
        method: 'POST',
        idempotencyKey: 'probe-500-1',
        body: { route_id: MODEL_ID, grant_id: grantId },
      }),
    );
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.probe_outcome, 'failed');
    assert.equal(body.data.failure_code, 'TRANSPORT_HTTP_500');
    assert.equal(body.data.evidence.transportProbed, true, 'the attempt was dispatched and is recorded');
    assert.equal(body.data.evidence.reportedModelId, null, 'no identity is claimed from a failed probe');
  } finally {
    serverMode = 'ok';
  }
});
