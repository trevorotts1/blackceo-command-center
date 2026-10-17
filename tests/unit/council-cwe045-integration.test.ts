/**
 * CWE-045 tests: final integration of the CWE-037 and CWE-050
 * remainders in Command Center.
 *
 *   1. Machine-principal binding for the CWE-036 action-plan routes
 *      (item 2b): a machine caller (subject operator:api) with a
 *      host-configured binding (MC_COUNCIL_MACHINE_BINDINGS_JSON)
 *      and the pinned installation header can preview, approve, and
 *      create WITHOUT a browser CSRF cookie; without the binding, the
 *      pin, or the operation in the binding, the routes refuse with
 *      COUNCIL_MACHINE_BINDING.
 *   2. Recorder wiring (items 1 and 2c): create's release step feeds
 *      every release outcome into CWE-037's recordReleaseOutcomes;
 *      refused releases land as release_outcome_recorded journal
 *      entries and the create receipt reports the recording counts.
 *   3. Completion-scan invocation and proposal surfacing (item 1):
 *      the composition root's sweep scans a completed session once
 *      (trigger completion), dedupes on re-run, and the session read
 *      surfaces pending scan items and proposal records, with no
 *      task ever created by scanning or processing.
 *   4. Intent surface binding (item 1): the seven registered
 *      intents dispatch through the composed engine from a surface
 *      message; ordinary text is not intercepted.
 *
 * Run with:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-cwe045-integration.test.ts
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
  'MC_COUNCIL_MACHINE_BINDINGS_JSON',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

const ALICE = 'owner:alice';
const MACHINE = 'operator:api';
const HOSTS = {
  'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', installationId: 'install-a' },
} as const;

function installFixtureEnv(): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', kind: 'self', installationId: 'install-a' },
  });
  process.env.MC_TENANT_SESSION_SECRET = 'cwe045-fixture-session-secret';
  process.env.MC_API_TOKEN = 'cwe045-fixture-operator-token';
  process.env.MC_CSRF_COOKIE_SECRET = 'cwe045-fixture-csrf-secret';
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

let previewRoute: { POST: RouteHandler };
let approveRoute: { POST: RouteHandler };
let createRoute: { POST: RouteHandler };
let sessionRoute: { GET: RouteHandler };
let repositories: import('../../src/lib/council/store').CouncilRepositories;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let contractFixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let SCHEMA_VERSIONS: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let db: import('better-sqlite3').Database;
let getCouncilEngineFn: typeof import('../../src/lib/council/engine').getCouncilEngine;
let handleCouncilSurfaceMessageFn: typeof import('../../src/lib/council/intent-surface').handleCouncilSurfaceMessage;

async function makeRequest(
  subject: string,
  path: string,
  options: { method?: string; body?: unknown; csrf?: boolean; idempotencyKey?: string; pinInstallation?: string } = {},
): Promise<NextRequest> {
  const headers: Record<string, string> = { host: 'council-a.test' };
  const cookies: string[] = [];
  const reg = HOSTS['council-a.test'];
  const token = await signTenantGrant({
    purpose: 'session',
    tenantId: reg.tenantId,
    companyId: reg.companyId,
    subject,
    host: 'council-a.test',
    installationId: reg.installationId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: `cwe045-${subject}-${Math.random()}`,
  });
  cookies.push(`mc_tenant_session=${token}`);
  if (options.csrf) {
    const { value } = await signCsrfToken();
    cookies.push(`mc_csrf_token=${value}`);
  }
  headers.cookie = cookies.join('; ');
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.pinInstallation) headers['x-expected-installation-id'] = options.pinInstallation;
  return new NextRequest(`https://council-a.test${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function seedCompanySession(sessionId: string, state = 'DRAFT'): { scope: never; briefSha256: string } {
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
      state,
      state_version: 3,
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

function commitVerdict(sessionId: string, scope: never, briefSha256: string, actions: Array<Record<string, unknown>>): void {
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
    action_proposals: actions.map((entry) => action(entry.action_id as string, entry)),
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

async function callPlanRoute(
  route: { POST: RouteHandler },
  sessionId: string,
  segment: string,
  subject: string,
  body: Record<string, unknown>,
  options: { csrf?: boolean; key?: string; pinInstallation?: string } = {},
): Promise<{ status: number; body: any }> {
  installFixtureEnv();
  const key = options.key ?? `key-${Math.random()}`;
  const request = await makeRequest(subject, `/api/council/sessions/${sessionId}/action-plan/${segment}`, {
    method: 'POST',
    csrf: options.csrf ?? false,
    idempotencyKey: key,
    pinInstallation: options.pinInstallation,
    body: { ...body, idempotency_key: key },
  });
  const response = await route.POST(request, { params: Promise.resolve({ id: sessionId }) });
  return { status: response.status, body: await response.json() };
}

function countWhere(table: string, where: string, ...params: unknown[]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;
}

function journalCount(sessionId: string, action: string): number {
  const rows = db
    .prepare(`SELECT payload_json FROM council_events WHERE session_id = ? AND type = 'operation_completed'`)
    .all(sessionId) as Array<{ payload_json: string }>;
  return rows.filter((row) => (JSON.parse(row.payload_json) as { action?: string }).action === action).length;
}

before(async () => {
  installFixtureEnv();
  previewRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/preview/route');
  approveRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/approve/route');
  createRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/create/route');
  sessionRoute = await import('../../src/app/api/council/sessions/[id]/route');
  const store = await import('../../src/lib/council/store');
  repositories = new store.CouncilRepositories();
  envelopeFromScopeFn = store.envelopeFromScope;
  const contracts = await import('../../src/lib/council/contracts');
  canonicalHashFn = contracts.canonicalHash;
  SCHEMA_VERSIONS = contracts.SCHEMA_VERSIONS;
  contractFixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  const dbModule = await import('../../src/lib/db');
  db = dbModule.getDb();
  // Task creation requires the host company and workspace rows.
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('company-a', 'Company A', 'company-a', '{}', ?, ?)`,
  ).run(nowIso, nowIso);
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, company_id, created_at, updated_at)
     VALUES ('default', 'Default', 'default', 'company-a', ?, ?)`,
  ).run(nowIso, nowIso);
  const engine = await import('../../src/lib/council/engine');
  getCouncilEngineFn = engine.getCouncilEngine;
  const surface = await import('../../src/lib/council/intent-surface');
  handleCouncilSurfaceMessageFn = surface.handleCouncilSurfaceMessage;
});

test('machine binding: configured machine callers run preview, approve, and create without CSRF', async () => {
  const sessionId = 'sess-machine-1';
  const { scope, briefSha256 } = seedCompanySession(sessionId);
  commitVerdict(sessionId, scope, briefSha256, [{ action_id: 'act-1' }, { action_id: 'act-2' }]);
  // The three routes' kanban methods declare read (list/get),
  // create_tasks (propose), approve_plan (decide), and execute
  // (assemble and release). A machine binding for the action-plan
  // routes names exactly the permissions the composed routes
  // exercise, no more.
  process.env.MC_COUNCIL_MACHINE_BINDINGS_JSON = JSON.stringify([
    { installation_id: 'install-a', company_id: 'company-a', operations: ['read', 'approve_plan', 'create_tasks', 'execute'] },
  ]);
  try {
    // Preview with the pin and no CSRF cookie: admitted under the binding.
    const preview = await callPlanRoute(previewRoute, sessionId, 'preview', MACHINE, { verdict_revision: 1 }, { pinInstallation: 'install-a', csrf: false });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const planHash = preview.body.data.plan_hash as string;

    // No pin header: the binding assertion refuses before any work.
    const unpinned = await callPlanRoute(approveRoute, sessionId, 'approve', MACHINE, { verdict_revision: 1, plan_hash: planHash }, { csrf: false });
    assert.equal(unpinned.status, 403, JSON.stringify(unpinned.body));
    assert.equal(unpinned.body.error.code, 'COUNCIL_MACHINE_BINDING');
    assert.equal(countWhere('council_approvals', 'session_id = ?', sessionId), 0);

    // Pinned approve and create succeed; the approval actor is the machine.
    const approved = await callPlanRoute(approveRoute, sessionId, 'approve', MACHINE, { verdict_revision: 1, plan_hash: planHash }, { pinInstallation: 'install-a', csrf: false, key: 'machine-approve-1' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.approved_by, MACHINE);
    const planId = approved.body.data.plan_id as string;

    const created = await callPlanRoute(createRoute, sessionId, 'create', MACHINE, { plan_id: planId, plan_hash: planHash }, { pinInstallation: 'install-a', csrf: false, key: 'machine-create-1' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.data.tasks.length, 2);
    for (const task of created.body.data.tasks) assert.equal(task.released, false);

    // A binding that omits the create operation refuses create.
    process.env.MC_COUNCIL_MACHINE_BINDINGS_JSON = JSON.stringify([
      { installation_id: 'install-a', company_id: 'company-a', operations: ['read', 'approve_plan', 'create_tasks'] },
    ]);
    const narrowed = await callPlanRoute(createRoute, sessionId, 'create', MACHINE, { plan_id: planId, plan_hash: planHash }, { pinInstallation: 'install-a', csrf: false, key: 'machine-create-2' });
    assert.equal(narrowed.status, 403, JSON.stringify(narrowed.body));
    assert.equal(narrowed.body.error.code, 'COUNCIL_MACHINE_BINDING');
  } finally {
    delete process.env.MC_COUNCIL_MACHINE_BINDINGS_JSON;
  }

  // No binding configured at all: machine mutation is refused, and a
  // browser caller without CSRF is still refused as before.
  const unbound = await callPlanRoute(previewRoute, sessionId, 'preview', MACHINE, { verdict_revision: 1 }, { pinInstallation: 'install-a', csrf: false });
  assert.equal(unbound.status, 403, JSON.stringify(unbound.body));
  assert.equal(unbound.body.error.code, 'COUNCIL_MACHINE_BINDING');
  const browserNoCsrf = await callPlanRoute(previewRoute, sessionId, 'preview', ALICE, { verdict_revision: 1 }, { csrf: false });
  assert.equal(browserNoCsrf.status, 403, JSON.stringify(browserNoCsrf.body));
  assert.equal(browserNoCsrf.body.error.code, 'COUNCIL_CSRF_REQUIRED');
});

test('recorder wiring: refused releases are recorded by create and reported on the receipt', async () => {
  const sessionId = 'sess-recorder-1';
  const { scope, briefSha256 } = seedCompanySession(sessionId);
  commitVerdict(sessionId, scope, briefSha256, [{ action_id: 'act-1' }, { action_id: 'act-2' }]);

  const preview = await callPlanRoute(previewRoute, sessionId, 'preview', ALICE, { verdict_revision: 1 }, { csrf: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const planHash = preview.body.data.plan_hash as string;
  const approved = await callPlanRoute(approveRoute, sessionId, 'approve', ALICE, { verdict_revision: 1, plan_hash: planHash }, { csrf: true, key: 'recorder-approve-1' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const planId = approved.body.data.plan_id as string;

  // Create with a grant reference that does not resolve: every
  // dependency-ready task's release is refused, and the refusals are
  // recorded through CWE-037's recorder in the same call.
  const created = await callPlanRoute(createRoute, sessionId, 'create', ALICE, { plan_id: planId, plan_hash: planHash, grant_ref: 'grant-that-does-not-exist' }, { csrf: true, key: 'recorder-create-1' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(created.body.data.release_recording, { recorded: 2, failed: 0 });
  assert.equal(journalCount(sessionId, 'release_outcome_recorded'), 2);
  for (const task of created.body.data.tasks) assert.equal(task.released, false);

  // Replay records nothing twice.
  const replayed = await callPlanRoute(createRoute, sessionId, 'create', ALICE, { plan_id: planId, plan_hash: planHash, grant_ref: 'grant-that-does-not-exist' }, { csrf: true, key: 'recorder-create-1' });
  assert.equal(replayed.status, 200);
  assert.equal(journalCount(sessionId, 'release_outcome_recorded'), 2);
});

test('completion-scan sweep: scans once, dedupes, surfaces proposals, creates no tasks', async () => {
  const sessionId = 'sess-sweep-1';
  const { scope, briefSha256 } = seedCompanySession(sessionId, 'COMPLETED');
  commitVerdict(sessionId, scope, briefSha256, [{ action_id: 'act-1' }]);
  const tasksBefore = countWhere('tasks', '1 = 1');

  const engine = getCouncilEngineFn();
  const first = await engine.runCompletionScansOnce();
  const mine = first.scanned.find((entry) => entry.session_id === sessionId);
  assert.ok(mine, `sweep scanned the completed session: ${JSON.stringify(first)}`);
  assert.equal(mine.trigger, 'completion');
  assert.ok(mine.enqueued >= 1, 'the outcome-review candidate was enqueued');
  assert.equal(journalCount(sessionId, 'completion_scan_recorded'), 1);
  assert.equal(countWhere('tasks', '1 = 1'), tasksBefore, 'scanning creates no tasks');

  const second = await engine.runCompletionScansOnce();
  assert.ok(!second.scanned.some((entry) => entry.session_id === sessionId), 'a second sweep dedupes');
  assert.ok(second.skipped.some((entry) => entry.session_id === sessionId && entry.reason === 'already_scanned'));

  // Proposal surfacing on the session read.
  installFixtureEnv();
  const beforeProcess = await sessionRoute.GET(await makeRequest(ALICE, `/api/council/sessions/${sessionId}`), { params: Promise.resolve({ id: sessionId }) });
  const beforeBody = await beforeProcess.json();
  assert.equal(beforeProcess.status, 200, JSON.stringify(beforeBody));
  assert.equal(beforeBody.meta.follow_ups.pending_scan_items.length, mine.enqueued);
  assert.equal(beforeBody.meta.follow_ups.proposals.length, 0);

  const { CouncilScanQueue } = await import('../../src/lib/council/kanban/scan-queue');
  const queue = new CouncilScanQueue({ repositories, db });
  const alice = {
    subject: ALICE,
    tenantKind: 'self',
    channel: 'browser',
    supportAccess: false,
    scope: { tenant_id: 'tenant-a', company_id: 'company-a', installation_id: 'install-a', owner_subject: null },
    tenant: { tenantId: 'tenant-a', companyId: 'company-a', clientId: null, kind: 'self', subject: ALICE, host: 'council-a.test', installationId: 'install-a' },
  } as unknown as import('../../src/lib/council/auth').CouncilPrincipal;
  const processed = await queue.processNextScanItem(alice, sessionId);
  assert.equal(processed.processed, true, 'one pending item processes into a proposal record');
  assert.equal(countWhere('tasks', '1 = 1'), tasksBefore, 'processing a scan item creates no task');

  const afterProcess = await sessionRoute.GET(await makeRequest(ALICE, `/api/council/sessions/${sessionId}`), { params: Promise.resolve({ id: sessionId }) });
  const afterBody = await afterProcess.json();
  assert.equal(afterBody.meta.follow_ups.proposals.length, 1);
  assert.equal(afterBody.meta.follow_ups.pending_scan_items.length, mine.enqueued - 1);
});

test('intent surface: registered intents dispatch through the composed engine; ordinary text passes through', async () => {
  const sessionId = 'sess-sweep-1';
  const alice = {
    subject: ALICE,
    tenantKind: 'self',
    channel: 'browser',
    supportAccess: false,
    scope: { tenant_id: 'tenant-a', company_id: 'company-a', installation_id: 'install-a', owner_subject: null },
    tenant: { tenantId: 'tenant-a', companyId: 'company-a', clientId: null, kind: 'self', subject: ALICE, host: 'council-a.test', installationId: 'install-a' },
  } as unknown as import('../../src/lib/council/auth').CouncilPrincipal;

  const read = await handleCouncilSurfaceMessageFn({
    principal: alice,
    text: 'What did they decide?',
    session_id: sessionId,
    origin: { kind: 'user', source_session_id: null },
  });
  assert.equal(read.intercepted, true);
  assert.equal(read.outcome?.kind, 'verdict_read');
  assert.match(read.summary ?? '', /WAIT/);

  const tasksBefore = countWhere('tasks', '1 = 1');
  const control = await handleCouncilSurfaceMessageFn({
    principal: alice,
    text: 'Stop that council',
    session_id: sessionId,
    origin: { kind: 'user', source_session_id: null },
  });
  assert.equal(control.intercepted, true);
  assert.equal(control.outcome?.kind, 'session_command');
  assert.equal(countWhere('tasks', '1 = 1'), tasksBefore, 'a session control creates no task');

  const ordinary = await handleCouncilSurfaceMessageFn({
    principal: alice,
    text: 'Remind me to water the plants on Friday',
    origin: { kind: 'user', source_session_id: null },
  });
  assert.equal(ordinary.intercepted, false);
});
