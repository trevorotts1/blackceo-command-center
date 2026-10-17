/**
 * CWE-048 closeout tests: O-1 replay receipt parity and O-2
 * query-credential coverage (observations carried from CWE-043,
 * CLAIMED by its verification stream and never independently
 * re-verified there; both are closed here).
 *
 * O-1: a replayed action-plan create (same idempotency key) used to
 * return a degraded receipt: parent_task_id null, per-task created
 * null, and edges empty, while the fresh receipt carried all three
 * from the assembly. The replay now rebuilds those fields from the
 * committed assembly journal (the plan_tasks_materialized entry,
 * whose payload itemizes the per-link created flags since this unit,
 * and the assembly_edges_resolved entry), so a replayed receipt
 * matches the fresh receipt on every assembly fact, with replayed:
 * true as the only intended difference.
 *
 * O-2: the query-credential rejection set covered the api_key
 * spellings and access_token but missed api_token. That spelling is
 * now rejected like the others. (It was never honored as a
 * credential; this closes a defense-in-depth rejection gap.)
 */
import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';
import { signCsrfToken } from '../../src/lib/csrf-protection';
import {
  assertNoQueryCredential,
  QUERY_CREDENTIAL_PARAMETERS,
} from '../../src/lib/council/auth';

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

const SESSION_SECRET = 'cwe048-fixture-session-secret';
const OPERATOR_TOKEN = 'cwe048-fixture-operator-token';
const CSRF_SECRET = 'cwe048-fixture-csrf-secret';

function installFixtureEnv(): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', kind: 'self', installationId: 'install-a' },
  });
  process.env.MC_TENANT_SESSION_SECRET = SESSION_SECRET;
  process.env.MC_API_TOKEN = OPERATOR_TOKEN;
  process.env.MC_CSRF_COOKIE_SECRET = CSRF_SECRET;
  delete process.env.MC_INTERVIEW_COOKIE_SECRET;
  delete process.env.MC_COUNCIL_SUPPORT_SUBJECTS;
}

type RouteHandler = (request: NextRequest, ctx?: unknown) => Promise<Response>;

let previewRoute: { POST: RouteHandler };
let approveRoute: { POST: RouteHandler };
let createRoute: { POST: RouteHandler };
let db: import('better-sqlite3').Database;
let repositories: import('../../src/lib/council/store').CouncilRepositories;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let SCHEMA_VERSIONS: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let contractFixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let closeDbFn: () => void;

const ALICE = 'owner:alice';

before(async () => {
  previewRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/preview/route');
  approveRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/approve/route');
  createRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/create/route');
  const dbModule = await import('../../src/lib/db');
  db = dbModule.getDb();
  closeDbFn = dbModule.closeDb;
  const store = await import('../../src/lib/council/store');
  repositories = new store.CouncilRepositories();
  envelopeFromScopeFn = store.envelopeFromScope;
  const contracts = await import('../../src/lib/council/contracts');
  canonicalHashFn = contracts.canonicalHash;
  SCHEMA_VERSIONS = contracts.SCHEMA_VERSIONS;
  contractFixtures = await import('../../src/lib/council/contracts/fixtures/examples');

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run('company-a', 'Company A', 'company-a', now, now);
});

after(() => {
  closeDbFn();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function makeRequest(
  subject: string,
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<NextRequest> {
  const headers: Record<string, string> = { host: 'council-a.test' };
  const token = await signTenantGrant({
    purpose: 'session',
    tenantId: 'tenant-a',
    companyId: 'company-a',
    subject,
    host: 'council-a.test',
    installationId: 'install-a',
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: `fixture-${subject}-${Math.random()}`,
  });
  const { value } = await signCsrfToken();
  headers.cookie = `mc_tenant_session=${token}; mc_csrf_token=${value}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return new NextRequest(`https://council-a.test${path}`, {
    method: 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function seedCompanySession(sessionId: string): { scope: never; briefSha256: string } {
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
  return { scope: scope as never, briefSha256: spec.brief_sha256 };
}

function commitVerdict(sessionId: string, scope: never, briefSha256: string): void {
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
  const envelope = envelopeFromScopeFn(scope, ALICE, 'owner', 'write');
  repositories.saveVerdict(envelope, verdict as never);
}

async function callRoute(
  route: { POST: RouteHandler },
  sessionId: string,
  segment: string,
  body: Record<string, unknown>,
  key: string,
): Promise<{ status: number; body: any }> {
  installFixtureEnv();
  const request = await makeRequest(ALICE, `/api/council/sessions/${sessionId}/action-plan/${segment}`, {
    idempotencyKey: key,
    body: { ...body, idempotency_key: key },
  });
  const response = await route.POST(request, { params: Promise.resolve({ id: sessionId }) });
  return { status: response.status, body: await response.json() };
}

test('O-1: a replayed create returns the same assembly facts as the fresh create', async () => {
  const sessionId = 'cwe048-sess-replay';
  const { scope, briefSha256 } = seedCompanySession(sessionId);
  commitVerdict(sessionId, scope, briefSha256);

  const preview = await callRoute(previewRoute, sessionId, 'preview', { verdict_revision: 1 }, 'cwe048-preview-1');
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const planHash = preview.body.data.plan_hash as string;

  const approved = await callRoute(approveRoute, sessionId, 'approve', {
    verdict_revision: 1,
    plan_hash: planHash,
  }, 'cwe048-approve-1');
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const planId = approved.body.data.plan_id as string;

  const created = await callRoute(createRoute, sessionId, 'create', {
    plan_id: planId,
    plan_hash: planHash,
  }, 'cwe048-create-1');
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const fresh = created.body.data;
  assert.equal(fresh.replayed, false);
  assert.ok(fresh.parent_task_id, 'fresh receipt names the parent task');
  assert.equal(fresh.tasks.length, 2);
  assert.equal(fresh.edges.length, 1);
  for (const task of fresh.tasks) assert.equal(task.created, true);

  const replayed = await callRoute(createRoute, sessionId, 'create', {
    plan_id: planId,
    plan_hash: planHash,
  }, 'cwe048-create-1');
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  const replay = replayed.body.data;
  assert.equal(replay.replayed, true);
  assert.equal(replay.plan_id, fresh.plan_id);
  assert.equal(replay.plan_hash, fresh.plan_hash);
  assert.equal(replay.assembly_id, fresh.assembly_id);
  assert.equal(replay.parent_task_id, fresh.parent_task_id);
  assert.deepEqual(replay.edges, fresh.edges);
  const freshByAction = new Map(fresh.tasks.map((t: any) => [t.action_id, t]));
  for (const task of replay.tasks) {
    const freshTask = freshByAction.get(task.action_id);
    assert.ok(freshTask, `replay carries ${task.action_id}`);
    assert.equal(task.task_id, freshTask.task_id);
    assert.equal(task.operation_id, freshTask.operation_id);
    assert.equal(task.created, freshTask.created, `created flag for ${task.action_id} survives the replay`);
  }
});

test('O-2: the api_token query spelling is rejected as a credential parameter', () => {
  installFixtureEnv();
  assert.ok(QUERY_CREDENTIAL_PARAMETERS.has('api_token'));
  assert.throws(
    () =>
      assertNoQueryCredential(
        new URL('https://council-a.test/api/council/sessions?api_token=fixture'),
      ),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: unknown }).code === 'COUNCIL_QUERY_CREDENTIAL',
  );
  // Case-insensitive, like every other spelling in the set.
  assert.throws(
    () =>
      assertNoQueryCredential(
        new URL('https://council-a.test/api/council/sessions?API_TOKEN=fixture'),
      ),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: unknown }).code === 'COUNCIL_QUERY_CREDENTIAL',
  );
});
