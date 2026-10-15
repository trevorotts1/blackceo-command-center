/**
 * council-composition.test.ts — CWE-050 production service
 * composition: the composed whole, not only the parts.
 *
 * Covers:
 *   1. The composition root (src/lib/council/engine.ts) binds the
 *      real accepted services — store, repositories, subscriptions,
 *      jobs, settings, report downloads, the CWE-049 run
 *      authorization service and its per-principal port adapter.
 *      No fixture or stub service appears anywhere in the surface
 *      (T123: the API foundation cannot resolve fixture services in
 *      production).
 *   2. Readiness is derived from actually bound services (T129):
 *      the registry holds all 32 Section 17 endpoints, all ready
 *      since CWE-045 graduated council.models.probe to its real
 *      composed service, and every ready endpoint's route file
 *      exists and contains no FEATURE_NOT_READY path.
 *   3. T122 producer/consumer scan: no ready endpoint is owned by a
 *      unit downstream of this composition (a hidden downstream
 *      prerequisite would make the readiness claim false).
 *   4. Item 3's guard chain with the REAL grant service behind
 *      CWE-036's port: an assembled plan's tasks stay held without
 *      a grant; after a real preview+approve through the CWE-049
 *      routes, re-running create with the grant releases exactly
 *      the dependency-ready task; a revoked grant releases nothing.
 *   5. The outbox pump runs from the composition root: committed
 *      session events drain to a subscriber on the engine's shared
 *      registry, and a second pump claims nothing.
 *   6. Settings through the composed service: canonical defaults
 *      at revision 0, CAS patch, stale-revision conflict, invalid
 *      values refused, scope isolation.
 *   7. /portraits static serving (CWE-034 remainder): every roster
 *      medallion exists under public/portraits byte-identical to
 *      the component source the pages bundle.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-composition.test.ts
 */

import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const SESSION_SECRET = 'fx-secret-4';
const OPERATOR_TOKEN = 'fx-token-4';
const CSRF_SECRET = 'fx-csrf-4';

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
let previewRoute: { POST: RouteHandler };
let approveRoute: { POST: RouteHandler };
let createRoute: { POST: RouteHandler };
let raPreviewRoute: { POST: RouteHandler };
let raApproveRoute: { POST: RouteHandler };
let raRevokeRoute: { POST: RouteHandler };
let repositories: import('../../src/lib/council/store').CouncilRepositories;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let SCHEMA_VERSIONS: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let contractFixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let composeCouncilEngineFn: typeof import('../../src/lib/council/engine').composeCouncilEngine;
let CouncilSettingsServiceCtor: typeof import('../../src/lib/council/settings').CouncilSettingsService;
let closeDbFn: () => void;
let db: import('better-sqlite3').Database;

before(async () => {
  previewRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/preview/route');
  approveRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/approve/route');
  createRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/create/route');
  raPreviewRoute = await import('../../src/app/api/council/sessions/[id]/run-authorization/preview/route');
  raApproveRoute = await import('../../src/app/api/council/sessions/[id]/run-authorization/approve/route');
  raRevokeRoute = await import('../../src/app/api/council/sessions/[id]/run-authorization/revoke/route');
  const store = await import('../../src/lib/council/store');
  repositories = new store.CouncilRepositories();
  envelopeFromScopeFn = store.envelopeFromScope;
  const contracts = await import('../../src/lib/council/contracts');
  canonicalHashFn = contracts.canonicalHash;
  SCHEMA_VERSIONS = contracts.SCHEMA_VERSIONS;
  contractFixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  const engineModule = await import('../../src/lib/council/engine');
  composeCouncilEngineFn = engineModule.composeCouncilEngine;
  const settingsModule = await import('../../src/lib/council/settings');
  CouncilSettingsServiceCtor = settingsModule.CouncilSettingsService;
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
const SCOPE = {
  tenant_id: 'tenant-a',
  company_id: 'company-a',
  installation_id: 'install-a',
  owner_subject: null as string | null,
};

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
  path: string,
  body: Record<string, unknown>,
  options: { key?: string; params?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  installFixtureEnv();
  const key = options.key ?? `key-${Math.random()}`;
  const request = await makeRequest('council-a.test', ALICE, path, {
    method: 'POST',
    csrf: true,
    idempotencyKey: key,
    body: { ...body, idempotency_key: key },
  });
  const response = await route.POST(request, { params: Promise.resolve(options.params ?? {}) });
  return { status: response.status, body: await response.json() };
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

function seedSessionWithVerdict(sessionId: string): void {
  const spec = JSON.parse(JSON.stringify(contractFixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(contractFixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.brief_sha256 = canonicalHashFn(brief);
  const stored = {
    spec,
    brief,
    scope: SCOPE,
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
  const envelope = envelopeFromScopeFn(SCOPE as never, ALICE, 'owner', 'write');
  repositories.createSession(envelope, stored as never);
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
    action_proposals: [action('act-1'), action('act-2', { depends_on_action_ids: ['act-1'] })],
    cheapest_informative_test: null,
    stop_criteria: [],
    review_criteria: [],
    resolution_support: null,
    validation_status: 'valid' as const,
    ratification_status: 'ratified' as const,
    brief_sha256: spec.brief_sha256,
  };
  const verdict = { ...base, content_sha256: canonicalHashFn(base) };
  repositories.saveVerdict(envelope, verdict as never);
}

async function approvePlanViaRoutes(sessionId: string): Promise<{ planId: string; planHash: string }> {
  const preview = await post(previewRoute, `/api/council/sessions/${sessionId}/action-plan/preview`, { verdict_revision: 1 }, { params: { id: sessionId } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const planHash = preview.body.data.plan_hash as string;
  const approved = await post(approveRoute, `/api/council/sessions/${sessionId}/action-plan/approve`, {
    verdict_revision: 1,
    plan_hash: planHash,
  }, { params: { id: sessionId } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { planId: approved.body.data.plan_id as string, planHash };
}

async function createViaRoutes(sessionId: string, planId: string, planHash: string, grantRef?: string) {
  const body: Record<string, unknown> = { plan_id: planId, plan_hash: planHash };
  if (grantRef) body.grant_ref = grantRef;
  return post(createRoute, `/api/council/sessions/${sessionId}/action-plan/create`, body, { params: { id: sessionId } });
}

async function approveRealGrant(sessionId: string): Promise<string> {
  const preview = await post(raPreviewRoute, `/api/council/sessions/${sessionId}/run-authorization/preview`, {
    route_snapshot: routeSnapshot(),
  }, { params: { id: sessionId } });
  assert.equal(preview.status, 201, JSON.stringify(preview.body));
  const approved = await post(raApproveRoute, `/api/council/sessions/${sessionId}/run-authorization/approve`, {
    preview_id: preview.body.data.preview_id,
  }, { params: { id: sessionId } });
  assert.equal(approved.status, 201, JSON.stringify(approved.body));
  assert.equal(approved.body.data.status, 'active');
  return approved.body.data.grant_id as string;
}

const WORKTREE = path.resolve(__dirname, '..', '..');

test('composition root binds the real services; no fixture service is reachable (T123)', () => {
  const engine = composeCouncilEngineFn();
  assert.ok(engine.store, 'store bound');
  assert.ok(engine.repositories, 'repositories bound');
  assert.ok(engine.subscriptions, 'one shared subscriptions registry');
  assert.ok(engine.jobs, 'job service bound');
  assert.ok(engine.settings, 'settings service bound');
  assert.ok(engine.reportDownloads.repositories, 'report downloads bound to the repositories');
  assert.ok(engine.reportDownloads.store, 'report downloads bound to the store');
  assert.equal(
    engine.runAuthorizationService.constructor.name,
    'CouncilRunAuthorizationService',
    'the real CWE-049 service is composed, not a stub',
  );
  const adapter = engine.runAuthorizationFor({
    tenant_id: 'tenant-a',
    company_id: 'company-a',
    installation_id: 'install-a',
    subject: ALICE,
    actor_kind: 'human',
    roles: ['owner'],
    scope: SCOPE,
    request_id: 'composition-check',
  } as never);
  assert.equal(adapter.constructor.name, 'CouncilRunAuthorizationAdapter', 'the port adapter is the composed one');
  assert.equal(typeof engine.pumpOutboxOnce, 'function');
});

test('readiness derives from bound services: 32 of 32 ready after CWE-045 (T129, T123)', async () => {
  const { COUNCIL_ENDPOINT_REGISTRY } = await import('../../src/lib/council/api/registry');
  assert.equal(COUNCIL_ENDPOINT_REGISTRY.length, 32, 'all 32 Section 17 endpoints are registered');
  const ready = COUNCIL_ENDPOINT_REGISTRY.filter((e) => e.readiness === 'ready');
  const notReady = COUNCIL_ENDPOINT_REGISTRY.filter((e) => e.readiness === 'not_ready');
  // CWE-045: council.models.probe graduated to its real composed
  // service (model-probe.ts); no endpoint remains not_ready.
  assert.equal(ready.length, 32);
  assert.deepEqual(notReady.map((e) => e.contract.contract_id), []);

  // Every ready endpoint's route file exists and carries no
  // FEATURE_NOT_READY path: the final assembly has no unbound
  // successful endpoint and no ready claim without a real handler.
  for (const entryReady of ready) {
    const routePath = entryReady.contract.path.replace(/:([A-Za-z0-9_]+)/g, '[$1]');
    const file = path.join(WORKTREE, 'src', 'app', routePath, 'route.ts');
    assert.ok(fs.existsSync(file), `${entryReady.contract.contract_id}: route file exists at ${routePath}`);
    const source = fs.readFileSync(file, 'utf8');
    // Strip comments first: CWE-030's events route legitimately
    // MENTIONS the retired stub in its header comment. The claim
    // being scanned is about code, not prose.
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !codeOnly.includes('FEATURE_NOT_READY') && !codeOnly.includes('handleNotReady'),
      `${entryReady.contract.contract_id}: graduated route file contains no not-ready handler`,
    );
  }
});

test('T122 producer/consumer scan: no ready endpoint depends on a downstream unit', async () => {
  const { COUNCIL_ENDPOINT_REGISTRY } = await import('../../src/lib/council/api/registry');
  for (const entry of COUNCIL_ENDPOINT_REGISTRY) {
    if (entry.readiness !== 'ready') continue;
    const match = /^CWE-(\d{3})/.exec(entry.owning_unit);
    assert.ok(match, `${entry.contract.contract_id}: owning unit is named (${entry.owning_unit})`);
    const unit = Number(match[1]);
    assert.ok(
      unit <= 50,
      `${entry.contract.contract_id}: owned by CWE-${unit}, which is not downstream of this composition`,
    );
    assert.ok(
      !/CWE-0(39|40|41|43|44|45|46|47|48)\b/.test(entry.contract.service_owner),
      `${entry.contract.contract_id}: service owner names no downstream unit (${entry.contract.service_owner})`,
    );
  }
});

test('guard chain with the real CWE-049 grant service behind the port: held without a grant, released per-task with one, nothing after revoke', async () => {
  // Session 1: assemble without a grant — everything stays held.
  const s1 = 'sess-compose-1';
  seedSessionWithVerdict(s1);
  const plan1 = await approvePlanViaRoutes(s1);
  const created1 = await createViaRoutes(s1, plan1.planId, plan1.planHash);
  assert.equal(created1.status, 200, JSON.stringify(created1.body));
  const childHolds1 = db
    .prepare(`SELECT dispatch_hold FROM tasks WHERE description LIKE ? AND id != ?`)
    .all(`%source-session:${s1}%`, created1.body.data.parent_task_id) as Array<{ dispatch_hold: number }>;
  assert.equal(childHolds1.length, 2);
  assert.ok(childHolds1.every((t) => t.dispatch_hold === 1), 'without a grant every plan task stays held');

  // Approve a REAL grant through the CWE-049 routes, then re-run
  // create naming it: act-1 (no dependencies) releases; act-2
  // (depends on act-1, not done) stays held. Release is per-task
  // through the full guard chain, never a blanket unhold.
  const grantId = await approveRealGrant(s1);
  const released = await createViaRoutes(s1, plan1.planId, plan1.planHash, grantId);
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const links = db
    .prepare(
      `SELECT l.action_id, t.dispatch_hold FROM council_task_links l
         JOIN tasks t ON t.id = l.task_id WHERE l.session_id = ? ORDER BY l.action_id ASC`,
    )
    .all(s1) as Array<{ action_id: string; dispatch_hold: number }>;
  assert.equal(links.length, 2);
  const byAction = Object.fromEntries(links.map((l) => [l.action_id, l.dispatch_hold]));
  assert.equal(byAction['act-1'], 0, 'act-1 released under the real grant');
  assert.equal(byAction['act-2'], 1, 'act-2 stays held: its dependency is not done');

  // Session 2: grant approved, then REVOKED before create. The
  // guard chain sees no active grant; both tasks stay held.
  const s2 = 'sess-compose-2';
  seedSessionWithVerdict(s2);
  const plan2 = await approvePlanViaRoutes(s2);
  const grant2 = await approveRealGrant(s2);
  const revoked = await post(raRevokeRoute, `/api/council/sessions/${s2}/run-authorization/revoke`, {
    grant_id: grant2,
  }, { params: { id: s2 } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  const created2 = await createViaRoutes(s2, plan2.planId, plan2.planHash, grant2);
  assert.equal(created2.status, 200, JSON.stringify(created2.body));
  const links2 = db
    .prepare(
      `SELECT t.dispatch_hold FROM council_task_links l JOIN tasks t ON t.id = l.task_id WHERE l.session_id = ?`,
    )
    .all(s2) as Array<{ dispatch_hold: number }>;
  assert.equal(links2.length, 2);
  assert.ok(links2.every((t) => t.dispatch_hold === 1), 'a revoked grant releases nothing');
});

test('outbox pump from the composition root drains committed events to engine subscribers exactly once', () => {
  const engine = composeCouncilEngineFn();
  const sessionId = 'sess-compose-pump';
  seedSessionWithVerdict(sessionId);
  const received: unknown[] = [];
  engine.subscriptions.subscribe({
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: 'install-a',
      session_id: sessionId,
      visibility: 'company',
      owner_subject: null,
    },
    contentAccess: true,
    send: (message) => received.push(message),
  });
  const first = engine.pumpOutboxOnce();
  assert.ok(first.claimed >= 1, `the pump claimed the session's committed intents (claimed=${first.claimed})`);
  assert.ok(received.length >= 1, 'the subscriber received the drained events');
  const second = engine.pumpOutboxOnce();
  assert.equal(second.claimed, 0, 'a second pump claims nothing: delivery happened exactly once');
});

test('settings through the composed service: defaults, CAS patch, conflicts, isolation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-settings-'));
  try {
    const settings = new CouncilSettingsServiceCtor(dir);
    const scopeA = { tenant_id: 'tenant-a', company_id: 'company-a', installation_id: 'install-a' };
    const scopeB = { tenant_id: 'tenant-a', company_id: 'company-b', installation_id: 'install-a' };
    const initial = settings.getSettings(scopeA as never);
    assert.equal(initial.revision, 0);
    assert.equal(initial.source, 'canonical_defaults');

    const patched = settings.patchSettings(scopeA as never, {
      expected_revision: 0,
      settings: { ...initial.settings, max_transport_retries_total: 12 },
      actor_subject: ALICE,
    });
    assert.equal(patched.revision, 1);
    assert.equal(patched.settings.max_transport_retries_total, 12);

    assert.throws(
      () =>
        settings.patchSettings(scopeA as never, {
          expected_revision: 0,
          settings: { ...initial.settings, max_transport_retries_total: 13 },
          actor_subject: ALICE,
        }),
      (error: any) => error?.code === 'VERSION_MISMATCH',
      'a stale expected revision conflicts',
    );
    assert.throws(
      () =>
        settings.patchSettings(scopeA as never, {
          expected_revision: 1,
          settings: { ...initial.settings, max_transport_retries_total: -5 },
          actor_subject: ALICE,
        }),
      (error: any) => error?.code === 'SCHEMA_VALIDATION',
      'an out-of-range value is refused by canonical validation',
    );
    const other = settings.getSettings(scopeB as never);
    assert.equal(other.revision, 0, 'another company scope is untouched');
    assert.equal(other.settings.max_transport_retries_total, initial.settings.max_transport_retries_total);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/portraits static serving: every roster medallion is served byte-identical to the bundled component source', () => {
  const seats = [
    'simon-sinek',
    'td-jakes',
    'oprah-winfrey',
    'tiffany-aliche',
    'russell-brunson',
    'michelle-obama',
    'brene-brown',
    'dennis-kimbro',
    'les-brown',
  ];
  for (const seat of seats) {
    for (const suffix of ['', '-sm']) {
      const name = `${seat}${suffix}.svg`;
      const served = path.join(WORKTREE, 'public', 'portraits', name);
      const source = path.join(WORKTREE, 'src', 'components', 'council', 'portraits', name);
      assert.ok(fs.existsSync(served), `public/portraits/${name} exists for static serving`);
      assert.ok(
        fs.readFileSync(served).equals(fs.readFileSync(source)),
        `public/portraits/${name} is byte-identical to the component source`,
      );
    }
  }
});
