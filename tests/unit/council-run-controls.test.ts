/**
 * council-run-controls.test.ts — CWE-050 run controls (CWE-027's CC
 * composition) behind POST /sessions/:id/start|pause|cancel|resume.
 *
 * Covers:
 *   1. Start admission: no active grant -> typed
 *      RUN_AUTHORIZATION_REQUIRED, the session stays DRAFT, and no
 *      durable job exists. With a real CWE-049 grant approved
 *      through the routes: 202, DRAFT -> READY -> QUEUED, and the
 *      council_jobs row carries the grant reference and its
 *      route-policy pin.
 *   2. T055: repeated controls are idempotent or precisely
 *      conflicting — start replay returns the original receipt,
 *      pause on a paused session returns its state, cancel on a
 *      cancelled session returns the same receipt, and resume on a
 *      non-paused session is a precise legal-state conflict.
 *   3. Pause/resume round trip: resume_phase records the
 *      interrupted phase (QUEUED) — not PAUSE_REQUESTED — and resume
 *      returns the session to exactly that phase.
 *   4. T058: a stale expected_version is refused with
 *      VERSION_MISMATCH and changes nothing.
 *   5. Cancel fences the durable job with the session.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-run-controls.test.ts
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

const SESSION_SECRET = 'fx-secret-1';
const OPERATOR_TOKEN = 'fx-token-1';
const CSRF_SECRET = 'fx-csrf-1';

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
let previewRoute: { POST: RouteHandler };
let approveRoute: { POST: RouteHandler };
let startRoute: { POST: RouteHandler };
let pauseRoute: { POST: RouteHandler };
let cancelRoute: { POST: RouteHandler };
let resumeRoute: { POST: RouteHandler };
let closeDbFn: () => void;
let db: import('better-sqlite3').Database;

before(async () => {
  sessionsRoute = await import('../../src/app/api/council/sessions/route');
  sessionRoute = await import('../../src/app/api/council/sessions/[id]/route');
  previewRoute = await import('../../src/app/api/council/sessions/[id]/run-authorization/preview/route');
  approveRoute = await import('../../src/app/api/council/sessions/[id]/run-authorization/approve/route');
  startRoute = await import('../../src/app/api/council/sessions/[id]/start/route');
  pauseRoute = await import('../../src/app/api/council/sessions/[id]/pause/route');
  cancelRoute = await import('../../src/app/api/council/sessions/[id]/cancel/route');
  resumeRoute = await import('../../src/app/api/council/sessions/[id]/resume/route');
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
    cookies.push('mc_csrf_token=' + value);
  }
  if (cookies.length > 0) headers.cookie = cookies.join('; ');
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return new NextRequest(`https://${host}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function post(
  route: { POST: RouteHandler },
  sessionId: string,
  segment: string,
  body: Record<string, unknown>,
  key?: string,
): Promise<{ status: number; body: any }> {
  installFixtureEnv();
  const idem = key ?? `key-${Math.random()}`;
  const request = await makeRequest('council-a.test', ALICE, `/api/council/sessions/${sessionId}/${segment}`, {
    method: 'POST',
    csrf: true,
    idempotencyKey: idem,
    body: { ...body, idempotency_key: idem },
  });
  const response = await route.POST(request, { params: Promise.resolve({ id: sessionId }) });
  return { status: response.status, body: await response.json() };
}

async function getState(sessionId: string): Promise<{ state: string; state_version: number; resume_phase: string | null }> {
  installFixtureEnv();
  const request = await makeRequest('council-a.test', ALICE, `/api/council/sessions/${sessionId}`);
  const response = await sessionRoute.GET(request, { params: Promise.resolve({ id: sessionId }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.data.state;
}

async function createDraft(): Promise<string> {
  installFixtureEnv();
  const request = await makeRequest('council-a.test', ALICE, '/api/council/sessions', {
    method: 'POST',
    csrf: true,
    idempotencyKey: `draft-${Math.random()}`,
    body: {
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
    },
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
    credential: { state: 'present', envVar: 'PROVIDER_A_API_KEY', source: 'process.env', checked: ['process.env'] },
    identityLevel: 'configured',
    scope: { tenantId: 'tenant-a', companyId: 'company-a', installationId: 'install-a', ownerSubject: null },
    createdAt: new Date().toISOString(),
  };
}

async function approveGrant(sessionId: string): Promise<string> {
  const preview = await post(previewRoute, sessionId, 'run-authorization/preview', {
    route_snapshot: routeSnapshot(),
  });
  assert.equal(preview.status, 201, JSON.stringify(preview.body));
  const approved = await post(approveRoute, sessionId, 'run-authorization/approve', {
    preview_id: preview.body.data.preview_id,
  });
  assert.equal(approved.status, 201, JSON.stringify(approved.body));
  return approved.body.data.grant_id as string;
}

function jobRows(sessionId: string): Array<{ id: string; state: string; payload_json: string }> {
  return db
    .prepare(`SELECT id, state, payload_json FROM council_jobs WHERE session_id = ? ORDER BY created_at ASC`)
    .all(sessionId) as Array<{ id: string; state: string; payload_json: string }>;
}

test('start admission: refused without a grant; with a real grant it enqueues a durable job and answers 202 (T055 replay-safe)', async () => {
  const sessionId = await createDraft();

  const refused = await post(startRoute, sessionId, 'start', {});
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'RUN_AUTHORIZATION_REQUIRED');
  assert.equal((await getState(sessionId)).state, 'DRAFT');
  assert.equal(jobRows(sessionId).length, 0);

  const grantId = await approveGrant(sessionId);
  const started = await post(startRoute, sessionId, 'start', {}, 'start-key-1');
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.data.state, 'QUEUED');
  assert.equal(started.body.data.grant_id, grantId);
  const jobs = jobRows(sessionId);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'queued');
  const payload = JSON.parse(jobs[0].payload_json);
  assert.equal(payload.grant_id, grantId);
  assert.match(payload.route_policy_sha256, /^[0-9a-f]{64}$/);

  // T055: replaying the start (same key) returns the original
  // receipt and enqueues nothing new.
  const replay = await post(startRoute, sessionId, 'start', {}, 'start-key-1');
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.meta.replayed, true);
  assert.equal(replay.body.data.job_id, started.body.data.job_id);
  assert.equal(jobRows(sessionId).length, 1);
});

test('pause/resume round trip restores the interrupted phase; cancel is terminal and fences the job (T055, T058)', async () => {
  const sessionId = await createDraft();
  await approveGrant(sessionId);
  const started = await post(startRoute, sessionId, 'start', {});
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const queuedVersion = (await getState(sessionId)).state_version;

  // T058: a stale expected_version is refused and changes nothing.
  const stale = await post(pauseRoute, sessionId, 'pause', { expected_version: 0 });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error.code, 'VERSION_MISMATCH');
  assert.equal((await getState(sessionId)).state, 'QUEUED');

  const paused = await post(pauseRoute, sessionId, 'pause', { expected_version: queuedVersion });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.data.state, 'PAUSED');
  const pausedState = await getState(sessionId);
  assert.equal(pausedState.state, 'PAUSED');
  assert.equal(pausedState.resume_phase, 'QUEUED', 'the resume target is the interrupted phase, never PAUSE_REQUESTED');

  // T055: pausing a paused session returns the same state.
  const pausedAgain = await post(pauseRoute, sessionId, 'pause', {});
  assert.equal(pausedAgain.status, 200);
  assert.equal(pausedAgain.body.data.state, 'PAUSED');
  assert.equal(pausedAgain.body.data.idempotent_replay, true);

  const resumed = await post(resumeRoute, sessionId, 'resume', {});
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.data.state, 'QUEUED');

  const cancelled = await post(cancelRoute, sessionId, 'cancel', {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.state, 'CANCELLED');
  const jobs = jobRows(sessionId);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'cancelled', 'the durable job is fenced with the session');

  // T055: cancel replay returns the same terminal receipt; resume
  // from a terminal state is a precise conflict.
  const cancelledAgain = await post(cancelRoute, sessionId, 'cancel', {});
  assert.equal(cancelledAgain.status, 200);
  assert.equal(cancelledAgain.body.data.state, 'CANCELLED');
  assert.equal(cancelledAgain.body.data.idempotent_replay, true);
  const resumeTerminal = await post(resumeRoute, sessionId, 'resume', {});
  assert.equal(resumeTerminal.status, 409, JSON.stringify(resumeTerminal.body));
  assert.equal(resumeTerminal.body.error.code, 'ILLEGAL_TRANSITION');
});

test('resume on a never-paused draft is a precise legal-state conflict, not a silent no-op (T055)', async () => {
  const sessionId = await createDraft();
  const resumed = await post(resumeRoute, sessionId, 'resume', {});
  assert.equal(resumed.status, 409, JSON.stringify(resumed.body));
  assert.equal(resumed.body.error.code, 'ILLEGAL_TRANSITION');
  assert.equal((await getState(sessionId)).state, 'DRAFT');
});
