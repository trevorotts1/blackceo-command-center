/**
 * council-run-authorization-routes.test.ts — CWE-050 composition of
 * CWE-049's CC adapter behind the Section 17 run-authorization
 * endpoints (preview / approve / get / revoke), plus the start
 * endpoint's grant admission.
 *
 * Covers:
 *   1. The full grant lifecycle through the real routes: preview
 *      (confers nothing; the anchor is born expired), approve (the
 *      one transition to an active grant), the redacted status read
 *      (no scope-proof internals, no secrets), revoke (fences the
 *      grant), and start refusing a revoked grant.
 *   2. T076: mutations require the CSRF proof; the status read
 *      performs no writes (grant count unchanged by reads).
 *   3. T079: malformed bodies (missing route snapshot, unknown keys)
 *      are SCHEMA_VALIDATION refusals before any service work.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-run-authorization-routes.test.ts
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
let sessionsRoute: { POST: RouteHandler };
let previewRoute: { POST: RouteHandler };
let approveRoute: { POST: RouteHandler };
let revokeRoute: { POST: RouteHandler };
let statusRoute: { GET: RouteHandler };
let startRoute: { POST: RouteHandler };
let closeDbFn: () => void;
let db: import('better-sqlite3').Database;

before(async () => {
  sessionsRoute = await import('../../src/app/api/council/sessions/route');
  previewRoute = await import('../../src/app/api/council/sessions/[id]/run-authorization/preview/route');
  approveRoute = await import('../../src/app/api/council/sessions/[id]/run-authorization/approve/route');
  revokeRoute = await import('../../src/app/api/council/sessions/[id]/run-authorization/revoke/route');
  statusRoute = await import('../../src/app/api/council/sessions/[id]/run-authorization/route');
  startRoute = await import('../../src/app/api/council/sessions/[id]/start/route');
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
    cookies.push(`mc_csrf_token=${value}`)
  }
  if (cookies.length > 0) headers.cookie = cookies.join('; ');
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return new NextRequest(`https://${host}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function callRoute(
  route: { POST: RouteHandler } | { GET: RouteHandler },
  sessionId: string,
  segment: string,
  body: Record<string, unknown> | null,
  options: { csrf?: boolean; key?: string; method?: string } = {},
): Promise<{ status: number; body: any }> {
  installFixtureEnv();
  const key = options.key ?? `key-${Math.random()}`;
  const isGet = (options.method ?? (body === null ? 'GET' : 'POST')) === 'GET';
  const request = await makeRequest(
    'council-a.test',
    ALICE,
    `/api/council/sessions/${sessionId}/${segment}`,
    isGet
      ? {}
      : { method: 'POST', csrf: options.csrf ?? true, idempotencyKey: key, body: { ...body, idempotency_key: key } },
  );
  const handler = (route as { POST: RouteHandler }).POST ?? (route as { GET: RouteHandler }).GET;
  const response = await handler(request, { params: Promise.resolve({ id: sessionId }) });
  return { status: response.status, body: await response.json() };
}

function draftBody(): Record<string, unknown> {
  return {
    mode: 'selected',
    visibility: 'company',
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
  };
}

async function createDraft(): Promise<string> {
  installFixtureEnv();
  const request = await makeRequest('council-a.test', ALICE, '/api/council/sessions', {
    method: 'POST',
    csrf: true,
    idempotencyKey: `draft-${Math.random()}`,
    body: draftBody(),
  });
  const response = await sessionsRoute.POST(request);
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data.spec.session_id as string;
}

function routeSnapshot(): Record<string, unknown> {
  return {
    schema: 'wise-elders.route-selection/v1',
    selectionSource: 'explicit',
    routeId: 'route-a',
    routeRevision: 1,
    routeKind: 'fixed_model',
    providerSlug: 'provider-a',
    requestedRoute: 'route-a',
    requestedModelOrAlias: 'model-a',
    combinationMembers: null,
    reasoning: { requested: null, applied: null, supported: null, limitation: null },
    fallbackPolicy: 'none',
    providerAccountRef: null,
    capabilitySnapshot: {
      contextWindowTokens: 200000,
      maxOutputTokens: 8000,
      capabilities: ['text'],
      supportedReasoningLevels: null,
    },
    credential: {
      state: 'present',
      envVar: 'PROVIDER_A_API_KEY',
      source: 'process.env',
      checked: ['process.env'],
    },
    identityLevel: 'configured',
    scope: {
      tenantId: 'tenant-a',
      companyId: 'company-a',
      installationId: 'install-a',
      ownerSubject: null,
    },
    createdAt: new Date().toISOString(),
  };
}

function grantRows(sessionId: string): Array<{ id: string; status: string; scope_proof: string }> {
  return db
    .prepare(
      `SELECT id, status, scope_proof FROM council_approvals
        WHERE kind = 'run_grant' AND session_id = ? ORDER BY issued_at ASC`,
    )
    .all(sessionId) as Array<{ id: string; status: string; scope_proof: string }>;
}

test('grant lifecycle through the routes: preview confers nothing, approve activates, status read is redacted, revoke fences, start refuses a revoked grant', async () => {
  const sessionId = await createDraft();

  // Preview: 201, confers_authorization false, anchor born expired.
  const preview = await callRoute(previewRoute, sessionId, 'run-authorization/preview', {
    route_snapshot: routeSnapshot(),
  });
  assert.equal(preview.status, 201, JSON.stringify(preview.body));
  assert.equal(preview.body.data.confers_authorization, false);
  const previewId = preview.body.data.preview_id as string;
  assert.ok(previewId);
  const previewRow = db
    .prepare(`SELECT grant_id FROM council_run_previews WHERE id = ? AND session_id = ?`)
    .get(previewId, sessionId) as { grant_id: string } | undefined;
  assert.ok(previewRow, 'the preview record exists');
  const anchor = grantRows(sessionId).find((row) => row.id === previewRow.grant_id);
  assert.ok(anchor, 'the preview anchor row exists');
  assert.equal(anchor.status, 'expired', 'the preview anchor is born expired and confers nothing');

  // Start before approval: refused, nothing enqueued.
  const earlyStart = await callRoute(startRoute, sessionId, 'start', {});
  assert.equal(earlyStart.status, 403, JSON.stringify(earlyStart.body));
  assert.equal(earlyStart.body.error.code, 'RUN_AUTHORIZATION_REQUIRED');

  // Approve: the one transition to an active grant.
  const approved = await callRoute(approveRoute, sessionId, 'run-authorization/approve', {
    preview_id: previewId,
  });
  assert.equal(approved.status, 201, JSON.stringify(approved.body));
  assert.equal(approved.body.data.status, 'active');
  const grantId = approved.body.data.grant_id as string;

  // Status read: redacted summary only.
  const status = await callRoute(statusRoute, sessionId, 'run-authorization', null, { method: 'GET' });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  const grantView = (status.body.data.grants as any[]).find((g) => g.grant_id === grantId);
  assert.ok(grantView, 'the granted record is listed');
  assert.equal(grantView.status, 'active');
  assert.equal(grantView.authority_mode, 'managed_principal');
  const serialized = JSON.stringify(status.body);
  assert.ok(!serialized.includes('scope_proof'), 'scope-proof internals are never serialized');
  assert.ok(!serialized.includes('route_snapshot'), 'route snapshot internals are never serialized');
  assert.ok(!serialized.includes('budget'), 'budget ledger internals are never serialized');

  // T076: the read performed no writes. (The CWE-049 approval
  // transitions the preview anchor row itself into the granted
  // record, so the session has exactly one run_grant row.)
  assert.equal(grantRows(sessionId).length, 1, 'the single anchor-turned-grant row, unchanged by reads');

  // Revoke: the grant fences.
  const revoked = await callRoute(revokeRoute, sessionId, 'run-authorization/revoke', {
    grant_id: grantId,
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.data.status, 'revoked');

  // Start with only a revoked grant: refused precisely.
  const startAfterRevoke = await callRoute(startRoute, sessionId, 'start', {});
  assert.equal(startAfterRevoke.status, 403, JSON.stringify(startAfterRevoke.body));
  assert.equal(startAfterRevoke.body.error.code, 'RUN_AUTHORIZATION_REQUIRED');
  const jobs = db
    .prepare(`SELECT COUNT(*) AS n FROM council_jobs WHERE session_id = ?`)
    .get(sessionId) as { n: number };
  assert.equal(jobs.n, 0, 'no run job was ever enqueued without an active grant');
});

test('T076/T079: approve without CSRF proof is refused; malformed preview bodies are SCHEMA_VALIDATION before any service work', async () => {
  const sessionId = await createDraft();

  const preview = await callRoute(previewRoute, sessionId, 'run-authorization/preview', {
    route_snapshot: routeSnapshot(),
  });
  assert.equal(preview.status, 201);
  const previewId = preview.body.data.preview_id as string;

  const noCsrf = await callRoute(
    approveRoute,
    sessionId,
    'run-authorization/approve',
    { preview_id: previewId },
    { csrf: false },
  );
  assert.equal(noCsrf.status, 403, JSON.stringify(noCsrf.body));

  const missingSnapshot = await callRoute(previewRoute, sessionId, 'run-authorization/preview', {
    ceilings: { max_provider_requests: 10 },
  });
  assert.equal(missingSnapshot.status, 400, JSON.stringify(missingSnapshot.body));
  assert.equal(missingSnapshot.body.error.code, 'SCHEMA_VALIDATION');

  const unknownKey = await callRoute(previewRoute, sessionId, 'run-authorization/preview', {
    route_snapshot: routeSnapshot(),
    invoke_model_now: true,
  });
  assert.equal(unknownKey.status, 400, JSON.stringify(unknownKey.body));
  assert.equal(unknownKey.body.error.code, 'SCHEMA_VALIDATION');
  assert.equal(grantRows(sessionId).length, 1, 'only the one valid preview anchor exists; malformed requests created nothing');
});
