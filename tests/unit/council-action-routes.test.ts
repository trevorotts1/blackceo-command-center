/**
 * CWE-036 action-plan route tests (directive Sections 17.5, 17.6,
 * 19.5; Section 35 contracts T090, T091, T092).
 *
 * The three graduated action-plan endpoints are exercised through
 * their real Next.js route handlers with the CWE-029 fixture pattern
 * (signed tenant grants, signed CSRF cookie, isolated database):
 *
 * - preview answers 200 with the exact plan hash and writes nothing
 *   (proven against the store and task tables in the database);
 * - approve with a hash preview never showed answers 409
 *   COUNCIL_PLAN_HASH_MISMATCH; approve with the exact hash commits
 *   bound approval rows under the calling principal;
 * - create before approval answers the typed refusal; after approval
 *   it materializes held tasks; a replayed create returns the same
 *   task IDs with replayed: true;
 * - a mutation without CSRF proof answers 403, and a cross-company
 *   caller gets the typed not-found (404), never the plan.
 *
 * The happy-path session is seeded through the CWE-006 store with a
 * null owner_subject (the kanban-visible company session shape
 * CWE-035 composes). A second test pins the current composed
 * behavior for a session created through the drafts route, which
 * stamps owner_subject with the creator: CWE-035 treats an
 * owner-scoped session as private and never projects it to the
 * board, so create answers an explicit not_assembled status with
 * zero tasks. Reconciling the drafts owner stamp with the kanban
 * private-session definition is CWE-050's composition work; this
 * suite pins the honest behavior until then.
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

const SESSION_SECRET = 'cwe036-fixture-session-secret';
const OPERATOR_TOKEN = 'cwe036-fixture-operator-token';
const CSRF_SECRET = 'cwe036-fixture-csrf-secret';

const HOSTS = {
  'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', installationId: 'install-a' },
  'council-a2.test': { tenantId: 'tenant-a', companyId: 'company-a2', installationId: 'install-a' },
} as const;
type Host = keyof typeof HOSTS;

function installFixtureEnv(): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', kind: 'self', installationId: 'install-a' },
    'council-a2.test': { tenantId: 'tenant-a', companyId: 'company-a2', kind: 'self', installationId: 'install-a' },
  });
  process.env.MC_TENANT_SESSION_SECRET = SESSION_SECRET;
  process.env.MC_API_TOKEN = OPERATOR_TOKEN;
  process.env.MC_CSRF_COOKIE_SECRET = CSRF_SECRET;
  delete process.env.MC_INTERVIEW_COOKIE_SECRET;
  delete process.env.MC_COUNCIL_SUPPORT_SUBJECTS;
}

type RouteHandler = (request: NextRequest, ctx?: unknown) => Promise<Response>;

let sessionsRoute: { POST: RouteHandler };
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
  sessionsRoute = await import('../../src/app/api/council/sessions/route');
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

/** A kanban-visible company session, seeded through the CWE-006 store. */
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
  options: { host?: Host; csrf?: boolean; key?: string } = {},
): Promise<{ status: number; body: any }> {
  installFixtureEnv();
  const key = options.key ?? `key-${Math.random()}`;
  const request = await makeRequest(options.host ?? 'council-a.test', ALICE, `/api/council/sessions/${sessionId}/action-plan/${segment}`, {
    method: 'POST',
    csrf: options.csrf ?? true,
    idempotencyKey: key,
    body: { ...body, idempotency_key: key },
  });
  const response = await route.POST(request, { params: Promise.resolve({ id: sessionId }) });
  return { status: response.status, body: await response.json() };
}

function countWhere(table: string, where: string, ...params: unknown[]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;
}

test('the three routes: preview is pure, approve binds, create materializes held, replay is stable', async () => {
  const sessionId = 'route-sess-main';
  const { scope, briefSha256 } = seedCompanySession(sessionId);
  commitVerdict(sessionId, scope, briefSha256);

  // Preview: 200, exact hash, and the database proves purity.
  const keysBefore = countWhere('council_request_keys', 'tenant_id = ?', 'tenant-a');
  const preview = await callRoute(previewRoute, sessionId, 'preview', { verdict_revision: 1 });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.ok, true);
  assert.equal(preview.body.data.preview_only, true);
  assert.match(preview.body.data.plan_hash, /^[0-9a-f]{64}$/);
  assert.equal(preview.body.data.approval_binding.plan_hash, preview.body.data.plan_hash);
  assert.equal(countWhere('tasks', 'description LIKE ?', `%source-session:${sessionId}%`), 0);
  assert.equal(countWhere('council_action_proposals', 'session_id = ?', sessionId), 0);
  assert.equal(countWhere('council_approvals', 'session_id = ?', sessionId), 0);
  assert.equal(countWhere('council_task_links', 'session_id = ?', sessionId), 0);
  assert.equal(countWhere('council_request_keys', 'tenant_id = ?', 'tenant-a'), keysBefore, 'preview claimed no request key');
  const planHash = preview.body.data.plan_hash as string;

  // Approve with a hash preview never showed: 409, no approval rows.
  const wrong = await callRoute(approveRoute, sessionId, 'approve', {
    verdict_revision: 1,
    plan_hash: '0'.repeat(64),
  });
  assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
  assert.equal(wrong.body.error.code, 'COUNCIL_PLAN_HASH_MISMATCH');
  assert.equal(countWhere('council_approvals', 'session_id = ?', sessionId), 0);

  // Create before any approval exists: refused with the typed error
  // (no plan was ever proposed, so there is no committed approval for
  // this hash), and no tasks appear.
  const early = await callRoute(createRoute, sessionId, 'create', { plan_hash: planHash });
  assert.equal(early.status, 404, JSON.stringify(early.body));
  assert.equal(early.body.error.code, 'COUNCIL_PLAN_NOT_CURRENT');
  assert.equal(countWhere('tasks', 'description LIKE ?', `%source-session:${sessionId}%`), 0);

  // Approve with the exact hash: committed rows under the principal.
  const approved = await callRoute(approveRoute, sessionId, 'approve', {
    verdict_revision: 1,
    plan_hash: planHash,
  }, { key: 'route-approve-1' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.coverage.complete, true);
  assert.equal(approved.body.data.approved_by, ALICE);
  const planId = approved.body.data.plan_id as string;
  assert.ok(planId, 'the approve response names the persisted plan');
  const approvalActors = db
    .prepare(`SELECT DISTINCT actor_subject FROM council_approvals WHERE session_id = ?`)
    .all(sessionId) as Array<{ actor_subject: string }>;
  assert.deepEqual(approvalActors, [{ actor_subject: ALICE }]);

  // Approve replay: same key returns the committed record.
  const approvedReplay = await callRoute(approveRoute, sessionId, 'approve', {
    verdict_revision: 1,
    plan_hash: planHash,
  }, { key: 'route-approve-1' });
  assert.equal(approvedReplay.status, 200);
  assert.equal(approvedReplay.body.data.replayed, true);

  // Create: held tasks with real IDs; nothing released (no grant).
  const created = await callRoute(createRoute, sessionId, 'create', {
    plan_id: planId,
    plan_hash: planHash,
  }, { key: 'route-create-1' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.data.tasks.length, 2);
  assert.ok(created.body.data.parent_task_id);
  for (const task of created.body.data.tasks) {
    assert.equal(task.released, false);
    const row = db
      .prepare(`SELECT dispatch_hold, status FROM tasks WHERE id = ?`)
      .get(task.task_id) as { dispatch_hold: number | null; status: string };
    assert.equal(row.dispatch_hold, 1);
    assert.equal(row.status, 'backlog');
  }
  assert.deepEqual(
    created.body.data.edges,
    [
      {
        action_id: 'act-2',
        task_id: created.body.data.tasks.find((t: any) => t.action_id === 'act-2').task_id,
        depends_on_action_id: 'act-1',
        depends_on_task_id: created.body.data.tasks.find((t: any) => t.action_id === 'act-1').task_id,
      },
    ],
  );

  // Create replay: same key, same task IDs, replayed flag set.
  const replayed = await callRoute(createRoute, sessionId, 'create', {
    plan_id: planId,
    plan_hash: planHash,
  }, { key: 'route-create-1' });
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.body.meta.replayed, true);
  assert.deepEqual(
    replayed.body.data.tasks.map((t: any) => t.task_id).sort(),
    created.body.data.tasks.map((t: any) => t.task_id).sort(),
  );
  assert.equal(countWhere('tasks', 'description LIKE ?', `%source-session:${sessionId}%`), 3);
});

test('a mutation without CSRF proof is refused, and a cross-company caller gets the typed not-found', async () => {
  const sessionId = 'route-sess-guards';
  const { scope, briefSha256 } = seedCompanySession(sessionId);
  commitVerdict(sessionId, scope, briefSha256);

  const noCsrf = await callRoute(previewRoute, sessionId, 'preview', { verdict_revision: 1 }, { csrf: false });
  assert.equal(noCsrf.status, 403, JSON.stringify(noCsrf.body));

  const crossCompany = await callRoute(previewRoute, sessionId, 'preview', { verdict_revision: 1 }, { host: 'council-a2.test' });
  assert.equal(crossCompany.status, 404, JSON.stringify(crossCompany.body));
  assert.equal(crossCompany.body.ok, false);
});

test('seam pin: a drafts-created session is owner-scoped, so create assembles nothing (CWE-050 reconciles)', async () => {
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
  const created = await response.json();
  assert.equal(response.status, 201, JSON.stringify(created));
  const sessionId = created.data.spec.session_id as string;
  commitVerdict(sessionId, created.data.scope, created.data.spec.brief_sha256);

  const preview = await callRoute(previewRoute, sessionId, 'preview', { verdict_revision: 1 });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const planHash = preview.body.data.plan_hash as string;
  const approved = await callRoute(approveRoute, sessionId, 'approve', {
    verdict_revision: 1,
    plan_hash: planHash,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const createResult = await callRoute(createRoute, sessionId, 'create', {
    plan_id: approved.body.data.plan_id,
    plan_hash: planHash,
  });
  assert.equal(createResult.status, 200, JSON.stringify(createResult.body));
  assert.equal(createResult.body.data.status, 'not_assembled_private_session');
  assert.equal(createResult.body.data.tasks.length, 0);
  assert.equal(countWhere('tasks', 'description LIKE ?', `%source-session:${sessionId}%`), 0);
});
