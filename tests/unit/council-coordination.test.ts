/**
 * council-coordination.test.ts — CWE-050 ancillary coordination and
 * the drafts-privacy seam reconciliation.
 *
 * Covers:
 *   1. THE SEAM, BOTH DIRECTIONS (CWE-036's pinned defect, CWE-050
 *      item 4): an API-created COMPANY session (drafts service
 *      stamps owner_subject as creator of record) now assembles its
 *      parent task and plan; a genuinely PRIVATE session still
 *      creates no board task, no link, and no child.
 *   2. Client decision recording bound to the exact verdict
 *      revision; a superseded revision records nothing.
 *   3. Follow-up coordination (T104): both accepted client shapes
 *      create a NEW linked consult in DRAFT; the parent's verdict is
 *      byte-identical afterwards; replay returns the same child.
 *   4. Rerun coordination: the child brief carries the changed
 *      fields, the diff is journaled, no approval or grant carries
 *      over.
 *   5. Outcome recording (T107): the preserved prediction snapshot
 *      (revision + content hash) is verified server-side; a wrong
 *      hash refuses the record.
 *   6. Archive (flag, not state; audit intact) and deletion
 *      (explicit confirmation required; tombstone; later reads
 *      answer deleted).
 *   7. Evidence read: the committed manifest entry, and a typed
 *      404 outside the manifest.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-coordination.test.ts
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

const SESSION_SECRET = 'fx-secret-2';
const OPERATOR_TOKEN = 'fx-token-2';
const CSRF_SECRET = 'fx-csrf-2';

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
let sessionsRoute: { POST: RouteHandler; GET: RouteHandler };
let sessionRoute: { GET: RouteHandler; DELETE: RouteHandler };
let previewRoute: { POST: RouteHandler };
let approveRoute: { POST: RouteHandler };
let createRoute: { POST: RouteHandler };
let decisionRoute: { POST: RouteHandler };
let followUpRoute: { POST: RouteHandler };
let rerunRoute: { POST: RouteHandler };
let outcomesRoute: { POST: RouteHandler };
let archiveRoute: { POST: RouteHandler };
let evidenceRoute: { GET: RouteHandler };
let repositories: import('../../src/lib/council/store').CouncilRepositories;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let SCHEMA_VERSIONS: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let closeDbFn: () => void;
let db: import('better-sqlite3').Database;

before(async () => {
  sessionsRoute = await import('../../src/app/api/council/sessions/route');
  sessionRoute = await import('../../src/app/api/council/sessions/[id]/route');
  previewRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/preview/route');
  approveRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/approve/route');
  createRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/create/route');
  decisionRoute = await import('../../src/app/api/council/sessions/[id]/decision/route');
  followUpRoute = await import('../../src/app/api/council/sessions/[id]/follow-up/route');
  rerunRoute = await import('../../src/app/api/council/sessions/[id]/rerun/route');
  outcomesRoute = await import('../../src/app/api/council/sessions/[id]/outcomes/route');
  archiveRoute = await import('../../src/app/api/council/sessions/[id]/archive/route');
  evidenceRoute = await import('../../src/app/api/council/sessions/[id]/evidence/[evidenceId]/route');
  const store = await import('../../src/lib/council/store');
  repositories = new store.CouncilRepositories();
  envelopeFromScopeFn = store.envelopeFromScope;
  const contracts = await import('../../src/lib/council/contracts');
  canonicalHashFn = contracts.canonicalHash;
  SCHEMA_VERSIONS = contracts.SCHEMA_VERSIONS;
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
  path: string,
  body: Record<string, unknown>,
  options: { key?: string; params?: Record<string, string>; subject?: string } = {},
): Promise<{ status: number; body: any }> {
  installFixtureEnv();
  const key = options.key ?? `key-${Math.random()}`;
  const request = await makeRequest('council-a.test', options.subject ?? ALICE, path, {
    method: 'POST',
    csrf: true,
    idempotencyKey: key,
    body: { ...body, idempotency_key: key },
  });
  const response = await route.POST(request, {
    params: Promise.resolve(options.params ?? {}),
  });
  return { status: response.status, body: await response.json() };
}

function draftBody(visibility: 'company' | 'private'): Record<string, unknown> {
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
      question: 'Should we pilot the revised offer before a broad launch?',
      options: [
        { id: 'A', label: 'Keep the current offer', kind: 'status_quo' },
        { id: 'B', label: 'Pilot the revised offer', kind: 'bounded_test' },
      ],
      facts: [{ id: 'fact-1', statement: 'Current conversion is 2.1%.', evidence_ids: ['ev-1'] }],
      assumptions: [],
      unknowns: [],
      constraints: [],
      relevance_weights: { 'simon-sinek': 2, 'brene-brown': 3 },
      critical_domains: [],
      evidence_manifest: [
        {
          evidence_id: 'ev-1',
          sha256: 'b'.repeat(64),
          source_kind: 'client_document',
          locator: 'client-docs/conversion-baseline.pdf',
        },
      ],
      private_preference_ref: null,
      display_timezone: 'America/New_York',
    },
  };
}

async function createDraftViaApi(visibility: 'company' | 'private'): Promise<{ sessionId: string; scope: any; briefSha256: string }> {
  const created = await post(sessionsRoute, '/api/council/sessions', draftBody(visibility));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const data = created.body.data;
  assert.equal(data.scope.owner_subject, ALICE, 'the drafts service stamps the creator as owner of record');
  return { sessionId: data.spec.session_id, scope: data.scope, briefSha256: data.spec.brief_sha256 };
}

function commitVerdict(sessionId: string, scope: any, briefSha256: string): { contentSha256: string } {
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
    brief_sha256: briefSha256,
  };
  const verdict = { ...base, content_sha256: canonicalHashFn(base) };
  const envelope = envelopeFromScopeFn(scope, ALICE, 'owner', 'write');
  repositories.saveVerdict(envelope, verdict as never);
  return { contentSha256: verdict.content_sha256 };
}

async function assembleViaRoutes(sessionId: string): Promise<{ status: number; body: any }> {
  const preview = await post(previewRoute, `/api/council/sessions/${sessionId}/action-plan/preview`, { verdict_revision: 1 }, { params: { id: sessionId } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const planHash = preview.body.data.plan_hash as string;
  const approved = await post(approveRoute, `/api/council/sessions/${sessionId}/action-plan/approve`, {
    verdict_revision: 1,
    plan_hash: planHash,
  }, { params: { id: sessionId } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return post(createRoute, `/api/council/sessions/${sessionId}/action-plan/create`, {
    plan_id: approved.body.data.plan_id,
    plan_hash: planHash,
  }, { params: { id: sessionId } });
}

function countWhere(table: string, where: string, ...params: unknown[]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;
}

test('drafts-privacy seam, direction 1: an API-created COMPANY session assembles its parent and plan', async () => {
  const { sessionId, scope, briefSha256 } = await createDraftViaApi('company');
  commitVerdict(sessionId, scope, briefSha256);
  const created = await assembleViaRoutes(sessionId);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.notEqual(created.body.data.status, 'not_assembled_private_session');
  assert.ok(created.body.data.parent_task_id, 'the parent task exists');
  assert.equal(created.body.data.tasks.length, 2);
  assert.equal(countWhere('tasks', 'description LIKE ?', `%source-session:${sessionId}%`), 3);
  assert.equal(countWhere('council_task_links', 'session_id = ?', sessionId), 2);
});

test('drafts-privacy seam, direction 2: a genuinely PRIVATE session creates no board task, link, or child', async () => {
  const { sessionId, scope, briefSha256 } = await createDraftViaApi('private');
  commitVerdict(sessionId, scope, briefSha256);
  const created = await assembleViaRoutes(sessionId);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.data.status, 'not_assembled_private_session');
  assert.equal(created.body.data.tasks.length, 0);
  assert.equal(countWhere('tasks', 'description LIKE ?', `%source-session:${sessionId}%`), 0);
  assert.equal(countWhere('council_task_links', 'session_id = ?', sessionId), 0);
});

test('decision recording binds the exact verdict revision; a superseded revision records nothing', async () => {
  const { sessionId, scope, briefSha256 } = await createDraftViaApi('company');
  commitVerdict(sessionId, scope, briefSha256);

  const stale = await post(decisionRoute, `/api/council/sessions/${sessionId}/decision`, {
    decision: 'accept',
    verdict_revision: 99,
  }, { params: { id: sessionId } });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error.code, 'VERSION_MISMATCH');

  const recorded = await post(decisionRoute, `/api/council/sessions/${sessionId}/decision`, {
    decision: 'accept',
    chosen_option_id: 'B',
    verdict_revision: 1,
  }, { params: { id: sessionId } });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.data.decision, 'accept');
  assert.equal(recorded.body.data.chosen_option_id, 'B');

  const envelope = envelopeFromScopeFn(scope, ALICE, 'owner', 'read');
  const events = repositories.listEvents(envelope, sessionId, 0);
  const decisions = events.filter(
    (e) => (e.payload as any).kind === 'council_coordination' && (e.payload as any).action === 'client_decision_recorded',
  );
  assert.equal(decisions.length, 1, 'exactly one decision was journaled (the stale attempt recorded nothing)');
  const chain = repositories.verifyChain(envelope, sessionId);
  assert.equal(chain.ok, true, 'the coordination events keep the journal hash chain valid');
});

test('follow-up coordination: both client shapes create a linked DRAFT consult; the parent verdict is untouched (T104)', async () => {
  const { sessionId, scope, briefSha256 } = await createDraftViaApi('company');
  const { contentSha256 } = commitVerdict(sessionId, scope, briefSha256);
  const readEnvelope = envelopeFromScopeFn(scope, ALICE, 'owner', 'read');
  const verdictBefore = repositories.getVerdict(readEnvelope, sessionId);

  const viaSessionClient = await post(followUpRoute, `/api/council/sessions/${sessionId}/follow-up`, {
    seat_id: 'simon-sinek',
    question: 'What is the smallest version of this pilot?',
  }, { params: { id: sessionId }, key: 'followup-key-1' });
  assert.equal(viaSessionClient.status, 202, JSON.stringify(viaSessionClient.body));
  const childId = viaSessionClient.body.data.child_session_id as string;
  assert.ok(childId);
  const child = repositories.getSession(readEnvelope, childId);
  assert.ok(child, 'the child session exists');
  assert.equal(child.state.state, 'DRAFT');
  assert.equal(child.spec.mode, 'consult');
  assert.deepEqual(child.spec.seat_ids, ['simon-sinek']);

  // Replay: same key, same child, no second child.
  const replay = await post(followUpRoute, `/api/council/sessions/${sessionId}/follow-up`, {
    seat_id: 'simon-sinek',
    question: 'What is the smallest version of this pilot?',
  }, { params: { id: sessionId }, key: 'followup-key-1' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.child_session_id, childId);
  assert.equal(replay.body.data.idempotent_replay, true);

  // The journey-client shape (target_kind/target_seat_id) works too.
  const viaJourney = await post(followUpRoute, `/api/council/sessions/${sessionId}/follow-up`, {
    question: 'What would make you withdraw that answer?',
    target_kind: 'advisor',
    target_seat_id: 'brene-brown',
  }, { params: { id: sessionId } });
  assert.equal(viaJourney.status, 202, JSON.stringify(viaJourney.body));
  assert.notEqual(viaJourney.body.data.child_session_id, childId);

  // Unknown seat: precise validation refusal.
  const badSeat = await post(followUpRoute, `/api/council/sessions/${sessionId}/follow-up`, {
    seat_id: 'oprah-winfrey',
    question: 'Not a seat of this session.',
  }, { params: { id: sessionId } });
  assert.equal(badSeat.status, 400, JSON.stringify(badSeat.body));
  assert.equal(badSeat.body.error.code, 'SCHEMA_VALIDATION');

  // T104: the parent's recommendation and verdict are unchanged.
  const verdictAfter = repositories.getVerdict(readEnvelope, sessionId);
  assert.equal(verdictAfter?.content_sha256, contentSha256);
  assert.equal(JSON.stringify(verdictAfter), JSON.stringify(verdictBefore));
});

test('rerun coordination: the child brief carries the changed facts, the diff is journaled, nothing is inherited', async () => {
  const { sessionId, scope, briefSha256 } = await createDraftViaApi('company');
  commitVerdict(sessionId, scope, briefSha256);
  const readEnvelope = envelopeFromScopeFn(scope, ALICE, 'owner', 'read');

  const rerun = await post(rerunRoute, `/api/council/sessions/${sessionId}/rerun`, {
    facts: [{ id: 'fact-1', statement: 'Current conversion is 3.4% after the pricing change.', evidence_ids: ['ev-1'] }],
  }, { params: { id: sessionId } });
  assert.equal(rerun.status, 201, JSON.stringify(rerun.body));
  assert.deepEqual(rerun.body.data.changed_fields, ['facts']);
  const child = repositories.getSession(readEnvelope, rerun.body.data.child_session_id);
  assert.ok(child);
  assert.equal(child.state.state, 'DRAFT');
  assert.equal(child.brief.facts[0].statement, 'Current conversion is 3.4% after the pricing change.');
  assert.equal(child.brief.question, 'Should we pilot the revised offer before a broad launch?');
  // No verdict, no approval, no grant on the child.
  assert.equal(repositories.getVerdict(readEnvelope, child.spec.session_id), null);
  assert.equal(countWhere('council_approvals', 'session_id = ?', child.spec.session_id), 0);

  const empty = await post(rerunRoute, `/api/council/sessions/${sessionId}/rerun`, {}, { params: { id: sessionId } });
  assert.equal(empty.status, 400, JSON.stringify(empty.body));
  assert.equal(empty.body.error.code, 'SCHEMA_VALIDATION');
});

test('outcome recording verifies the prediction snapshot server-side (T107)', async () => {
  const { sessionId, scope, briefSha256 } = await createDraftViaApi('company');
  const { contentSha256 } = commitVerdict(sessionId, scope, briefSha256);

  const wrongHash = await post(outcomesRoute, `/api/council/sessions/${sessionId}/outcomes`, {
    observed_outcome: 'We piloted and conversion rose.',
    observed_at: '2026-11-01T00:00:00.000Z',
    verdict_revision: 1,
    verdict_content_sha256: 'c'.repeat(64),
  }, { params: { id: sessionId } });
  assert.equal(wrongHash.status, 409, JSON.stringify(wrongHash.body));
  assert.equal(wrongHash.body.error.code, 'VERSION_MISMATCH');
  assert.equal(countWhere('council_outcome_reviews', 'session_id = ?', sessionId), 0);

  const recorded = await post(outcomesRoute, `/api/council/sessions/${sessionId}/outcomes`, {
    observed_outcome: 'We piloted and conversion rose.',
    observed_at: '2026-11-01T00:00:00.000Z',
    verdict_revision: 1,
    verdict_content_sha256: contentSha256,
  }, { params: { id: sessionId } });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
  const row = db
    .prepare(`SELECT planned_measure_json, verdict_label FROM council_outcome_reviews WHERE session_id = ?`)
    .get(sessionId) as { planned_measure_json: string; verdict_label: string };
  const planned = JSON.parse(row.planned_measure_json);
  assert.equal(planned.verdict_content_sha256, contentSha256, 'the prediction snapshot is preserved beside the outcome');
  assert.equal(planned.recommended_option_id, 'B');
  assert.equal(row.verdict_label, 'WAIT');
});

test('archive is a flag with the audit intact; deletion needs explicit confirmation and tombstones', async () => {
  const { sessionId, scope } = await createDraftViaApi('company');
  const readEnvelope = envelopeFromScopeFn(scope, ALICE, 'owner', 'read');
  const version = repositories.getSession(readEnvelope, sessionId)?.state.state_version ?? 0;
  const journalBefore = repositories.listEvents(readEnvelope, sessionId, 0).length;

  const archived = await post(archiveRoute, `/api/council/sessions/${sessionId}/archive`, {
    expected_version: version,
  }, { params: { id: sessionId } });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.data.archived, true);
  const after = repositories.getSession(readEnvelope, sessionId);
  assert.equal(after?.state.archived, true);
  assert.equal(after?.state.state, 'DRAFT', 'archive never changes the state');
  assert.ok(repositories.listEvents(readEnvelope, sessionId, 0).length >= journalBefore, 'the journal survives archiving');

  // Delete without the explicit confirmation: refused, session intact.
  installFixtureEnv();
  const noConfirm = await sessionRoute.DELETE(
    await makeRequest('council-a.test', ALICE, `/api/council/sessions/${sessionId}`, {
      method: 'DELETE',
      csrf: true,
      idempotencyKey: `del-noconfirm-${Math.random()}`,
      body: {},
    }),
    { params: Promise.resolve({ id: sessionId }) },
  );
  assert.equal(noConfirm.status, 400);
  assert.ok(repositories.getSession(readEnvelope, sessionId), 'the session survives an unconfirmed delete');

  installFixtureEnv();
  const deleted = await sessionRoute.DELETE(
    await makeRequest('council-a.test', ALICE, `/api/council/sessions/${sessionId}`, {
      method: 'DELETE',
      csrf: true,
      idempotencyKey: `del-confirm-${Math.random()}`,
      body: { confirm: true },
    }),
    { params: Promise.resolve({ id: sessionId }) },
  );
  const deletedBody = await deleted.json();
  assert.equal(deleted.status, 200, JSON.stringify(deletedBody));
  assert.equal(deletedBody.data.deleted, true);
  assert.equal(repositories.isDeleted('tenant-a', sessionId), true, 'the tombstone is recorded');
});

test('evidence read returns the committed manifest entry; an unknown ID is a typed 404', async () => {
  const { sessionId } = await createDraftViaApi('company');
  installFixtureEnv();
  const found = await evidenceRoute.GET(
    await makeRequest('council-a.test', ALICE, `/api/council/sessions/${sessionId}/evidence/ev-1`),
    { params: Promise.resolve({ id: sessionId, evidenceId: 'ev-1' }) },
  );
  const foundBody = await found.json();
  assert.equal(found.status, 200, JSON.stringify(foundBody));
  assert.equal(foundBody.data.provenance, 'brief_evidence_manifest');
  assert.equal(foundBody.data.entry.locator, 'client-docs/conversion-baseline.pdf');
  assert.equal(foundBody.data.entry.sha256, 'b'.repeat(64));

  installFixtureEnv();
  const missing = await evidenceRoute.GET(
    await makeRequest('council-a.test', ALICE, `/api/council/sessions/${sessionId}/evidence/ev-nope`),
    { params: Promise.resolve({ id: sessionId, evidenceId: 'ev-nope' }) },
  );
  const missingBody = await missing.json();
  assert.equal(missing.status, 404);
  assert.equal(missingBody.error.code, 'COUNCIL_EVIDENCE_NOT_FOUND');
});
