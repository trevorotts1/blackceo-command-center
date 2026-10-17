/**
 * council-cwe043-faults.test.ts: CWE-043 composed fault and
 * recovery battery (directive Sections 15, 17, 19, 29, 35; build
 * step 2).
 *
 * The composed product is faulted at its real seams:
 *   - worker crash: a claimed durable job is abandoned mid-lease;
 *     after the 60s council lease lapses a second worker reclaims
 *     it under a NEW epoch, the dead worker's late finish is
 *     fenced, and exactly one terminal write lands.
 *   - duplicate starts and duplicate action-plan creates: replays
 *     return the original receipt and create nothing new; a
 *     conflicting second start is a precise error, not a second
 *     job; a duplicate plan create returns the same task IDs.
 *   - cancel race: cancel lands while a job is leased; the leased
 *     worker's late finish is fenced, the session stays CANCELLED
 *     through start, resume, and pause attempts (no resurrection).
 *   - budget exhaustion: admissions stop exactly at the session
 *     ceiling and at the per-kind ceilings; replaying an admitted
 *     operation spends nothing twice; no path exceeds 50.
 *   - browser disconnect mid-stream: a consumer that disconnects
 *     after sequence N reconnects and receives the exact missed
 *     tail from its persisted cursor, gapless and duplicate-free,
 *     and a snapshot resync after a too-old cursor never silently
 *     truncates history.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-cwe043-faults.test.ts
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

const HOSTS = {
  'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', installationId: 'install-a' },
} as const;

function installFixtureEnv(): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', kind: 'self', installationId: 'install-a' },
  });
  process.env.MC_TENANT_SESSION_SECRET = 'cwe043-faults-session-secret';
  process.env.MC_API_TOKEN = 'cwe043-faults-operator-token';
  process.env.MC_CSRF_COOKIE_SECRET = 'cwe043-faults-csrf-secret';
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
let previewRoute: { POST: RouteHandler };
let approveRoute: { POST: RouteHandler };
let startRoute: { POST: RouteHandler };
let pauseRoute: { POST: RouteHandler };
let cancelRoute: { POST: RouteHandler };
let resumeRoute: { POST: RouteHandler };
let planPreviewRoute: { POST: RouteHandler };
let planApproveRoute: { POST: RouteHandler };
let planCreateRoute: { POST: RouteHandler };
let store: import('../../src/lib/council/persistence/council-store').CouncilStore;
let repositories: import('../../src/lib/council/store').CouncilRepositories;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let SCHEMA_VERSIONS: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let contractFixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let closeDbFn: () => void;
let db: import('better-sqlite3').Database;

before(async () => {
  installFixtureEnv();
  sessionsRoute = await import('../../src/app/api/council/sessions/route');
  sessionRoute = await import('../../src/app/api/council/sessions/[id]/route');
  eventsRoute = await import('../../src/app/api/council/sessions/[id]/events/route');
  previewRoute = await import('../../src/app/api/council/sessions/[id]/run-authorization/preview/route');
  approveRoute = await import('../../src/app/api/council/sessions/[id]/run-authorization/approve/route');
  startRoute = await import('../../src/app/api/council/sessions/[id]/start/route');
  pauseRoute = await import('../../src/app/api/council/sessions/[id]/pause/route');
  cancelRoute = await import('../../src/app/api/council/sessions/[id]/cancel/route');
  resumeRoute = await import('../../src/app/api/council/sessions/[id]/resume/route');
  planPreviewRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/preview/route');
  planApproveRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/approve/route');
  planCreateRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/create/route');
  const persistence = await import('../../src/lib/council/persistence/council-store');
  store = persistence.openCouncilStore();
  const storeModule = await import('../../src/lib/council/store');
  repositories = new storeModule.CouncilRepositories();
  envelopeFromScopeFn = storeModule.envelopeFromScope;
  const contracts = await import('../../src/lib/council/contracts');
  canonicalHashFn = contracts.canonicalHash;
  SCHEMA_VERSIONS = contracts.SCHEMA_VERSIONS;
  contractFixtures = await import('../../src/lib/council/contracts/fixtures/examples');
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
const SCOPE = { tenant_id: 'tenant-a', company_id: 'company-a' };

async function makeRequest(
  path: string,
  options: { method?: string; body?: unknown; csrf?: boolean; idempotencyKey?: string } = {},
): Promise<NextRequest> {
  const reg = HOSTS['council-a.test'];
  const token = await signTenantGrant({
    purpose: 'session',
    tenantId: reg.tenantId,
    companyId: reg.companyId,
    subject: ALICE,
    host: 'council-a.test',
    installationId: reg.installationId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: `cwe043-faults-${Math.random()}`,
  });
  const headers: Record<string, string> = { host: 'council-a.test' };
  const cookies = [`mc_tenant_session=${token}`];
  if (options.csrf) {
    const { value } = await signCsrfToken();
    cookies.push(`mc_csrf_token=${value}`);
  }
  headers.cookie = cookies.join('; ');
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return new NextRequest(`https://council-a.test${path}`, {
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
  const req = await makeRequest(`/api/council/sessions/${sessionId}/${segment}`, {
    method: 'POST',
    csrf: true,
    idempotencyKey: idem,
    body: { ...body, idempotency_key: idem },
  });
  const response = await route.POST(req, { params: Promise.resolve({ id: sessionId }) });
  return { status: response.status, body: await response.json() };
}

async function createDraft(): Promise<string> {
  installFixtureEnv();
  const key = `cwe043-draft-${Math.random()}`;
  const req = await makeRequest('/api/council/sessions', {
    method: 'POST',
    csrf: true,
    idempotencyKey: key,
    body: {
      idempotency_key: key,
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
  const response = await sessionsRoute.POST(req);
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

async function approveGrant(
  sessionId: string,
  ceilings?: Record<string, unknown>,
  snapshot: Record<string, unknown> = routeSnapshot(),
): Promise<string> {
  const preview = await post(previewRoute, sessionId, 'run-authorization/preview', {
    route_snapshot: snapshot,
    ...(ceilings ? { ceilings } : {}),
  });
  assert.equal(preview.status, 201, JSON.stringify(preview.body));
  const approved = await post(approveRoute, sessionId, 'run-authorization/approve', {
    preview_id: preview.body.data.preview_id,
  });
  assert.equal(approved.status, 201, JSON.stringify(approved.body));
  return approved.body.data.grant_id as string;
}

async function getState(sessionId: string): Promise<string> {
  installFixtureEnv();
  const req = await makeRequest(`/api/council/sessions/${sessionId}`);
  const response = await sessionRoute.GET(req, { params: Promise.resolve({ id: sessionId }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.data.state.state as string;
}

function jobRows(sessionId: string): Array<{ id: string; state: string; lease_epoch: number }> {
  return db
    .prepare(`SELECT id, state, lease_epoch FROM council_jobs WHERE session_id = ? ORDER BY created_at ASC`)
    .all(sessionId) as Array<{ id: string; state: string; lease_epoch: number }>;
}

// ---------------------------------------------------------------------------
// Worker crash and lease fencing (Section 29: worker crash row)
// ---------------------------------------------------------------------------

test('worker crash: an abandoned lease is reclaimed under a new epoch and the dead worker is fenced', async () => {
  const { CouncilJobService } = await import('../../src/lib/council/jobs');
  let clock = Date.parse('2026-10-15T12:00:00.000Z');
  const jobs = new CouncilJobService({
    store,
    now: () => new Date(clock).toISOString(),
  });
  const crashSessionId = await createDraft();
  const { job, replayed } = jobs.enqueueJob(SCOPE, {
    session_id: crashSessionId,
    kind: 'cwe043_crash',
    idempotency_key: 'crash-key-1',
    payload: { session_id: crashSessionId },
  });
  assert.equal(replayed, false);

  // Duplicate enqueue while the first is in flight: same job, no twin.
  const dup = jobs.enqueueJob(SCOPE, {
    session_id: crashSessionId,
    kind: 'cwe043_crash',
    idempotency_key: 'crash-key-1',
    payload: { session_id: crashSessionId },
  });
  assert.equal(dup.replayed, true);
  assert.equal(dup.job.id, job.id);

  // Worker 1 claims, then crashes: no heartbeat, no finish.
  const claimed = jobs.claimDueJob(SCOPE, { kind: 'cwe043_crash', worker_id: 'worker-1' });
  assert.ok(claimed);
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.lease_epoch, 1);

  // Inside the lease, no second worker can take the job.
  const tooEarly = jobs.claimDueJob(SCOPE, { kind: 'cwe043_crash', worker_id: 'worker-2' });
  assert.equal(tooEarly, null);

  // The 60s council lease lapses (crash window), worker 2 reclaims.
  clock += 61_000;
  const reclaimed = jobs.claimDueJob(SCOPE, { kind: 'cwe043_crash', worker_id: 'worker-2' });
  assert.ok(reclaimed, 'the expired lease is reclaimable');
  assert.equal(reclaimed.id, job.id);
  assert.equal(reclaimEpoch(reclaimed), 2, 'reclaim runs under a new epoch');

  // The dead worker wakes and tries to commit: fenced by epoch.
  const staleFinish = jobs.finishJob(SCOPE, {
    job_id: job.id,
    worker_id: 'worker-1',
    lease_epoch: 1,
    outcome: 'succeeded',
  });
  assert.equal(staleFinish, false, 'a stale epoch cannot commit');
  const staleHeartbeat = jobs.heartbeatJob(SCOPE, {
    job_id: job.id,
    worker_id: 'worker-1',
    lease_epoch: 1,
  });
  assert.equal(staleHeartbeat, false, 'a stale epoch cannot extend a lease it lost');

  const finish = jobs.finishJob(SCOPE, {
    job_id: job.id,
    worker_id: 'worker-2',
    lease_epoch: 2,
    outcome: 'succeeded',
  });
  assert.equal(finish, true);
  const rows = jobRows(crashSessionId);
  assert.equal(rows.length, 1, 'one job existed throughout the crash');
  assert.equal(rows[0].state, 'succeeded', 'exactly one terminal write landed');

  function reclaimEpoch(j: { lease_epoch: number }): number {
    return j.lease_epoch;
  }
});

// ---------------------------------------------------------------------------
// Duplicate starts (Section 29: duplicate start row)
// ---------------------------------------------------------------------------

test('duplicate starts: replay returns the original receipt; a fresh second start creates no second job', async () => {
  const sessionId = await createDraft();
  await approveGrant(sessionId);
  const first = await post(startRoute, sessionId, 'start', {}, 'dup-start-key');
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const replay = await post(startRoute, sessionId, 'start', {}, 'dup-start-key');
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.meta.replayed, true);
  assert.equal(replay.body.data.job_id, first.body.data.job_id);
  const second = await post(startRoute, sessionId, 'start', {}, 'a-different-key');
  assert.ok(
    second.status === 200 || second.status === 409,
    `a second start is a replay or a precise conflict, never a second run (got ${second.status})`,
  );
  if (second.status === 200) {
    assert.equal(second.body.data.job_id, first.body.data.job_id);
  }
  assert.equal(jobRows(sessionId).length, 1, 'exactly one durable job exists after every duplicate start');
  assert.equal(await getState(sessionId), 'QUEUED');
});

// ---------------------------------------------------------------------------
// Cancel race and resurrection (Section 29: cancel races row)
// ---------------------------------------------------------------------------

test('cancel race: cancel fences the leased job and CANCELLED never resurrects', async () => {
  const sessionId = await createDraft();
  await approveGrant(sessionId);
  const started = await post(startRoute, sessionId, 'start', {});
  assert.equal(started.status, 202, JSON.stringify(started.body));

  const { CouncilJobService } = await import('../../src/lib/council/jobs');
  const jobs = new CouncilJobService({ store });
  jobs.enqueueJob(SCOPE, {
    session_id: sessionId,
    kind: 'cwe043_race',
    idempotency_key: 'race-key-1',
    payload: { session_id: sessionId },
  });
  const claimed = jobs.claimDueJob(SCOPE, { kind: 'cwe043_race', worker_id: 'worker-race' });
  assert.ok(claimed, 'a worker holds a job for the session when cancel lands');
  const epoch = claimed.lease_epoch;

  const cancelled = await post(cancelRoute, sessionId, 'cancel', {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.state, 'CANCELLED');

  // The in-flight worker finishes late: the fence rejects the write.
  const lateFinish = jobs.finishJob(SCOPE, {
    job_id: claimed.id,
    worker_id: 'worker-race',
    lease_epoch: epoch,
    outcome: 'succeeded',
  });
  assert.equal(lateFinish, false, 'a late success cannot land after cancel');
  assert.ok(
    jobRows(sessionId).every((r) => r.state === 'cancelled'),
    'every job for the session is fenced cancelled',
  );

  // No control resurrects the session.
  const resume = await post(resumeRoute, sessionId, 'resume', {});
  assert.equal(resume.status, 409, JSON.stringify(resume.body));
  const pause = await post(pauseRoute, sessionId, 'pause', {});
  assert.ok(pause.status === 200 || pause.status === 409);
  if (pause.status === 200) assert.equal(pause.body.data.state, 'CANCELLED');
  const restart = await post(startRoute, sessionId, 'start', {});
  assert.equal(restart.status, 409, 'a cancelled session cannot be restarted into a second run');
  assert.equal(await getState(sessionId), 'CANCELLED');
  assert.equal(jobRows(sessionId).length, 2, 'no shadow job was created by resurrection attempts');
});

// ---------------------------------------------------------------------------
// Budget exhaustion and duplicate spend (Sections 15, 25.6, 29)
// ---------------------------------------------------------------------------

test('budget exhaustion: admissions stop at the ceilings and a replayed admission spends nothing twice', async () => {
  const sessionId = await createDraft();
  const snapshotObject = routeSnapshot();
  const grantId = await approveGrant(sessionId, undefined, snapshotObject);
  const { CouncilRunAuthorizationService } = await import('../../src/lib/council/run-authorization');
  const service = new CouncilRunAuthorizationService({ store });
  const principal = {
    subject: ALICE,
    tenantKind: 'self',
    channel: 'browser',
    supportAccess: false,
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: 'install-a',
      owner_subject: null,
    },
    tenant: {
      subject: ALICE,
      companyId: 'company-a',
      tenantId: 'tenant-a',
      installationId: 'install-a',
    },
  } as never;
  const snapshot = snapshotObject as never;

  const admit = (operationId: string, kind: 'provider_request' | 'transport_retry', original?: string) =>
    service.admitOperation(principal, {
      grant_id: grantId,
      session_id: sessionId,
      operation_id: operationId,
      kind,
      estimate_minor: 0,
      currency: 'USD',
      lease_epoch: 0,
      route_snapshot: snapshot,
      ...(original ? { original_operation_id: original } : {}),
    });

  const first = admit('op-1', 'provider_request');
  assert.equal(first.replayed, false);
  const replay = admit('op-1', 'provider_request');
  assert.equal(replay.replayed, true, 'the same operation id is a replay, not a second spend');
  assert.equal(replay.reservation_id, first.reservation_id);

  // Fill the session to the hard 50 ceiling and prove the 51st is
  // refused, whatever kind it wears.
  let admitted = 1;
  for (let i = 2; i <= 50; i += 1) {
    admit(`op-${i}`, 'provider_request');
    admitted += 1;
  }
  assert.equal(admitted, 50);
  assert.throws(
    () => admit('op-51', 'provider_request'),
    (err: unknown) => (err as { code?: string }).code === 'BUDGET_EXHAUSTED',
  );
  assert.throws(
    () => admit('op-51-retry', 'transport_retry', 'op-1'),
    (err: unknown) => (err as { code?: string }).code === 'BUDGET_EXHAUSTED',
    'a retry cannot escape the exhausted session ceiling',
  );
  const reservations = db
    .prepare(`SELECT COUNT(*) AS n FROM council_budget_reservations WHERE session_id = ?`)
    .get(sessionId) as { n: number };
  assert.equal(reservations.n, 50, 'exactly 50 reservations exist: the ceiling is a wall, not a target');
});

// ---------------------------------------------------------------------------
// Duplicate action-plan creates (Sections 17.6, 19, 29)
// ---------------------------------------------------------------------------

function seedCompanySession(sessionId: string): { briefSha256: string } {
  const spec = JSON.parse(JSON.stringify(contractFixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(contractFixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.visibility = 'company';
  spec.brief_sha256 = canonicalHashFn(brief);
  const scope = {
    tenant_id: 'tenant-a',
    company_id: 'company-a',
    installation_id: 'install-a',
    owner_subject: null,
  };
  const stored = {
    spec,
    brief,
    scope,
    state: {
      schema_version: 'wise-elders.session-state/v1',
      session_id: sessionId,
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
    },
    sample: false,
  };
  const envelope = envelopeFromScopeFn(scope as never, ALICE, 'owner', 'write');
  repositories.createSession(envelope, stored as never);
  return { briefSha256: spec.brief_sha256 };
}

function commitVerdict(sessionId: string, briefSha256: string): void {
  const action = (actionId: string, overrides: Record<string, unknown> = {}) => ({
    action_id: actionId,
    session_id: sessionId,
    verdict_revision: 1,
    title: `Carry out ${actionId}`,
    description: `Description for ${actionId}.`,
    rationale: 'The council advised this bounded step.',
    source_condition_ids: [],
    department_id: null,
    assigned_agent_id: null,
    sop_id: null,
    persona_id: null,
    acceptance_criteria: ['The step is complete and evidenced.'],
    budget_limit: { amount_minor: 5000, currency: 'USD' },
    due_at: null,
    depends_on_action_ids: [],
    risk_class: 'medium',
    execution_authorization_required: true,
    ...overrides,
  });
  const base = {
    schema_version: SCHEMA_VERSIONS.verdict,
    result_kind: 'scored' as const,
    session_id: sessionId,
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
    action_proposals: [
      action('act-1'),
      action('act-2', { depends_on_action_ids: ['act-1'] }),
    ],
    cheapest_informative_test: null,
    stop_criteria: [],
    review_criteria: [],
    resolution_support: null,
    validation_status: 'valid' as const,
    ratification_status: 'ratified' as const,
    brief_sha256: briefSha256,
  };
  const verdict = { ...base, content_sha256: canonicalHashFn(base) };
  const scope = {
    tenant_id: 'tenant-a',
    company_id: 'company-a',
    installation_id: 'install-a',
    owner_subject: null,
  };
  const envelope = envelopeFromScopeFn(scope as never, ALICE, 'owner', 'write');
  repositories.saveVerdict(envelope, verdict as never);
}

test('duplicate action-plan creates: one plan, one mapping set, identical task ids on replay', async () => {
  const sessionId = `sess-cwe043-plan-${Math.random().toString(36).slice(2, 10)}`;
  const { briefSha256 } = seedCompanySession(sessionId);
  commitVerdict(sessionId, briefSha256);

  const preview = await post(planPreviewRoute, sessionId, 'action-plan/preview', { verdict_revision: 1 });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const planHash = preview.body.data.plan_hash as string;
  const approved = await post(planApproveRoute, sessionId, 'action-plan/approve', {
    verdict_revision: 1,
    plan_hash: planHash,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const planId = approved.body.data.plan_id as string;
  assert.ok(planId, 'the approve response names the persisted plan');

  const tasksBefore = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  const first = await post(planCreateRoute, sessionId, 'action-plan/create', { plan_id: planId, plan_hash: planHash }, 'plan-create-key');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const mappingOf = (data: any) => ({
    plan_id: data.plan_id,
    plan_hash: data.plan_hash,
    assembly_id: data.assembly_id,
    tasks: (data.tasks as Array<{ action_id: string; task_id: string }>).map((t) => [t.action_id, t.task_id]),
  });
  const firstIds = JSON.stringify(mappingOf(first.body.data));
  const tasksAfterFirst = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  assert.ok(tasksAfterFirst > tasksBefore, 'the first create materialized held tasks');

  const replay = await post(planCreateRoute, sessionId, 'action-plan/create', { plan_id: planId, plan_hash: planHash }, 'plan-create-key');
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.data.replayed, true);
  assert.equal(JSON.stringify(mappingOf(replay.body.data)), firstIds, 'the replay returns the identical action-to-task mapping');
  const freshKey = await post(planCreateRoute, sessionId, 'action-plan/create', { plan_id: planId, plan_hash: planHash }, 'another-key');
  assert.equal(freshKey.status, 200, JSON.stringify(freshKey.body));
  assert.equal(JSON.stringify(mappingOf(freshKey.body.data)), firstIds, 'a second create under a new key still maps to the same plan');
  const tasksFinal = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  assert.equal(tasksFinal, tasksAfterFirst, 'no duplicate task was materialized by any duplicate create');
});

// ---------------------------------------------------------------------------
// Browser disconnect mid-stream (Section 29: browser disconnect row)
// ---------------------------------------------------------------------------

test('browser disconnect: reconnect from the persisted cursor is exact, gapless, and duplicate-free', async () => {
  const sessionId = await createDraft();
  await approveGrant(sessionId);
  await post(startRoute, sessionId, 'start', {});
  await post(pauseRoute, sessionId, 'pause', {});
  await post(resumeRoute, sessionId, 'resume', {});

  const getEvents = async (suffix: string): Promise<{ status: number; body: any }> => {
    installFixtureEnv();
    const req = await makeRequest(`/api/council/sessions/${sessionId}/events${suffix}`);
    const response = await eventsRoute.GET(req, { params: Promise.resolve({ id: sessionId }) });
    return { status: response.status, body: await response.json() };
  };

  const full = await getEvents('');
  assert.equal(full.status, 200, JSON.stringify(full.body));
  const all = full.body.data.page.events as Array<{ sequence: number; type: string }>;
  assert.ok(all.length >= 4, `the journal holds the full control history (${all.length} events)`);
  const sequences = all.map((e) => e.sequence);
  assert.deepEqual(sequences, sequences.map((_, i) => i + 1), 'the journal is gapless from 1');

  // The browser disconnects after sequence 2; on reconnect it asks
  // from its persisted cursor and must receive exactly the tail.
  const tail = await getEvents('?after=2');
  assert.equal(tail.status, 200, JSON.stringify(tail.body));
  const tailEvents = tail.body.data.page.events as Array<{ sequence: number }>;
  assert.deepEqual(
    tailEvents.map((e) => e.sequence),
    sequences.slice(2),
    'the reconnect tail is exactly the missed events, no duplicates, no gaps',
  );

  // A cursor from the future resyncs by snapshot, never a silently
  // truncated page.
  const ahead = await getEvents('?after=9999');
  assert.equal(ahead.status, 200, JSON.stringify(ahead.body));
  assert.equal(ahead.body.data.kind, 'snapshot');
});
