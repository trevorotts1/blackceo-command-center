/**
 * council-exports-cc.test.ts — CWE-050: CWE-038's CC remainder
 * (report-downloads + the CC print template) behind the Section 17
 * export endpoints, with the B15 closure proof on the CC evidence
 * path.
 *
 * Covers:
 *   1. T105 (CC half): Markdown, the canonical record JSON, and the
 *      print HTML are rendered from ONE model and agree on scores,
 *      the decision, conditions, citation locators, and the report
 *      revision; the record binds the sibling artifact hashes and
 *      names the PDF deliverable not_ready with its missing piece.
 *      The score fixture is the directive's golden case (A weighted
 *      sum 132 over denominator 22 = 6.0; B 168/22, display 7.6,
 *      spread 3).
 *   2. PDF (and 'all', which includes it) refuses
 *      EXPORT_FORMAT_NOT_READY naming the missing renderer; no
 *      bytes are produced and nothing is journaled.
 *   3. B15 closure: create -> journal record -> deliverable row on
 *      the session's parent task through registerDeliverable ->
 *      download bytes whose SHA-256 equals both the journaled
 *      artifact hash and the deliverable row's hash, with the
 *      verdict content hash bound in the headers.
 *   4. Replay (T078): the same idempotency key returns the same
 *      export with no second journal record; the same key with a
 *      different payload is a 409 conflict.
 *   5. T059 (CC half): deleting the session between create and
 *      download exposes nothing — the Section 16.5 cascade purges
 *      the export record with the session, so the download refuses
 *      EXPORT_DELIVERABLE_NOT_FOUND; and the in-flight race
 *      (tombstone landing between locate and read) refuses
 *      EXPORT_SESSION_DELETED inside readCouncilExport.
 *   6. A private session's export is owner-only: another company
 *      principal cannot download it.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-exports-cc.test.ts
 */

import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const SESSION_SECRET = 'fx-secret-3';
const OPERATOR_TOKEN = 'fx-token-3';
const CSRF_SECRET = 'fx-csrf-3';

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
let sessionRoute: { DELETE: RouteHandler };
let previewRoute: { POST: RouteHandler };
let approveRoute: { POST: RouteHandler };
let createRoute: { POST: RouteHandler };
let exportsRoute: { POST: RouteHandler };
let exportRoute: { GET: RouteHandler };
let repositories: import('../../src/lib/council/store').CouncilRepositories;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let SCHEMA_VERSIONS: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let contractFixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let closeDbFn: () => void;
let db: import('better-sqlite3').Database;

before(async () => {
  sessionRoute = await import('../../src/app/api/council/sessions/[id]/route');
  previewRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/preview/route');
  approveRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/approve/route');
  createRoute = await import('../../src/app/api/council/sessions/[id]/action-plan/create/route');
  exportsRoute = await import('../../src/app/api/council/exports/route');
  exportRoute = await import('../../src/app/api/council/exports/[exportId]/route');
  const store = await import('../../src/lib/council/store');
  repositories = new store.CouncilRepositories();
  envelopeFromScopeFn = store.envelopeFromScope;
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
const BOB = 'owner:bob';

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

const SCOPE = {
  tenant_id: 'tenant-a',
  company_id: 'company-a',
  installation_id: 'install-a',
  owner_subject: null as string | null,
};

function seedSession(sessionId: string, visibility: 'company' | 'private', owner: string | null): void {
  const spec = JSON.parse(JSON.stringify(contractFixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(contractFixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.visibility = visibility;
  spec.brief_sha256 = canonicalHashFn(brief);
  const scope = { ...SCOPE, owner_subject: owner };
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
  const envelope = envelopeFromScopeFn(scope as never, owner ?? ALICE, 'owner', 'write');
  repositories.createSession(envelope, stored as never);
}

function advisorCard(sessionId: string, seatId: string, operationId: string): Record<string, unknown> {
  return {
    schema_version: 'wise-elders.card/v1',
    session_id: sessionId,
    brief_revision: 1,
    seat_id: seatId,
    input_manifest_sha256: canonicalHashFn({ manifest: operationId }),
    pack_version: 'pack-fixture-1.0.0',
    card_kind: 'advisor',
    round: 2,
    stance: 'support',
    preferred_option_id: 'B',
    option_scores: [
      { option_id: 'A', score: 5, rationale: 'Fixture rationale.', evidence_ids: ['ev-1'] },
      { option_id: 'B', score: 8, rationale: 'Fixture rationale.', evidence_ids: ['ev-1'] },
    ],
    framework_applications: [],
    decisive_arguments: ['The pilot is the bounded next step.'],
    strongest_objection: 'Retention is unmeasured.',
    conditions: [],
    critical_unknowns: [],
    change_my_mind: 'Evidence the pilot cannot be staffed.',
    challenges_answered: [],
    quotes: [],
    evidence_strength: 'medium',
    minority_position: null,
    host: {
      scope: { ...SCOPE },
      operation_id: operationId,
      route_id: 'route-fixture-1',
      session_id: sessionId,
      stamped_at: '2026-10-14T12:00:00.000Z',
      source_status: 'unverified',
    },
  };
}

function commitCardsAndVerdict(sessionId: string, scope: Record<string, unknown>): { contentSha256: string } {
  const envelope = envelopeFromScopeFn(scope as never, ALICE, 'owner', 'write');
  const fence = { expected_state_version: 0, cancel_generation: 0, lease_epoch: 0 };
  repositories.acceptCard(envelope, advisorCard(sessionId, 'simon-sinek', `op-${sessionId}-1`) as never, fence);
  repositories.acceptCard(envelope, advisorCard(sessionId, 'brene-brown', `op-${sessionId}-2`) as never, fence);
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
  const session = repositories.getSession(envelope, sessionId);
  const base = {
    schema_version: SCHEMA_VERSIONS.verdict,
    result_kind: 'scored' as const,
    session_id: sessionId,
    verdict_revision: 1,
    recommended_option_id: 'B',
    label: 'GO_WITH_CONDITIONS' as const,
    option_scores: [
      { option_id: 'A', score: 6, display_score: 6, weighted_sum: 132, denominator: 22, coverage: 1, spread: 0 },
      { option_id: 'B', score: 168 / 22, display_score: 7.6, weighted_sum: 168, denominator: 22, coverage: 1, spread: 3 },
    ],
    active_weights: { 'simon-sinek': 2, 'brene-brown': 3 },
    evidence_strength: 'medium' as const,
    hard_constraint_findings: [],
    main_reasons: ['The bounded pilot dominates on the recorded weights.'],
    strongest_dissent: 'Retention is unmeasured.',
    accepted_amendments: [],
    rejected_amendments: [],
    critical_unknowns: [],
    prerequisites: ['Staff the pilot owner.'],
    action_proposals: [action('act-1')],
    cheapest_informative_test: null,
    stop_criteria: [],
    review_criteria: [],
    resolution_support: null,
    validation_status: 'valid' as const,
    ratification_status: 'ratified' as const,
    brief_sha256: session?.spec.brief_sha256,
  };
  const verdict = { ...base, content_sha256: canonicalHashFn(base) };
  repositories.saveVerdict(envelope, verdict as never);
  return { contentSha256: verdict.content_sha256 };
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
  const response = await route.POST(request, { params: Promise.resolve(options.params ?? {}) });
  return { status: response.status, body: await response.json() };
}

async function createExport(sessionId: string, body: Record<string, unknown>, key?: string, subject = ALICE) {
  return post(exportsRoute, '/api/council/exports', { session_id: sessionId, ...body }, { key, subject });
}

async function download(exportId: string, subject = ALICE): Promise<{ status: number; text: string; headers: Headers }> {
  installFixtureEnv();
  const request = await makeRequest('council-a.test', subject, `/api/council/exports/${exportId}`);
  const response = await exportRoute.GET(request, { params: Promise.resolve({ exportId }) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function exportJournalCount(sessionId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM council_events
        WHERE session_id = ? AND type = 'operation_completed'
          AND json_extract(payload_json, '$.kind') = 'report_export'`,
    )
    .get(sessionId) as { n: number };
  return row.n;
}

test('T105 + B15: formats agree from one model; the deliverable row and the download bytes hash-match the journal record', async () => {
  const sessionId = 'sess-export-1';
  seedSession(sessionId, 'company', null);
  const { contentSha256 } = commitCardsAndVerdict(sessionId, SCOPE);

  // Assemble so the session has a parent task for B15 registration.
  const preview = await post(previewRoute, `/api/council/sessions/${sessionId}/action-plan/preview`, { verdict_revision: 1 }, { params: { id: sessionId } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const planHash = preview.body.data.plan_hash as string;
  const approved = await post(approveRoute, `/api/council/sessions/${sessionId}/action-plan/approve`, {
    verdict_revision: 1,
    plan_hash: planHash,
  }, { params: { id: sessionId } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const assembled = await post(createRoute, `/api/council/sessions/${sessionId}/action-plan/create`, {
    plan_id: approved.body.data.plan_id,
    plan_hash: planHash,
  }, { params: { id: sessionId } });
  assert.equal(assembled.status, 200, JSON.stringify(assembled.body));
  const parentTaskId = assembled.body.data.parent_task_id as string;
  assert.ok(parentTaskId);

  const created = await createExport(sessionId, { format: 'markdown' }, 'export-key-1');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const artifact = created.body.data.artifacts[0];
  assert.equal(artifact.format, 'markdown');
  assert.ok(artifact.deliverable_id, 'B15: the artifact registered a deliverable row');

  // B15: the deliverable row binds the parent task, the filename,
  // and the exact artifact hash.
  const deliverable = db
    .prepare(`SELECT task_id, path, sha256 FROM task_deliverables WHERE id = ?`)
    .get(artifact.deliverable_id) as { task_id: string; path: string; sha256: string };
  assert.equal(deliverable.task_id, parentTaskId);
  assert.equal(deliverable.path, artifact.filename);
  assert.equal(deliverable.sha256, artifact.sha256);

  // Download: bytes hash to the journaled + registered hash, and
  // the verdict binding rides the headers.
  const dl = await download(artifact.export_id);
  assert.equal(dl.status, 200);
  assert.equal(sha256(dl.text), artifact.sha256, 'download bytes hash-match the journaled artifact hash');
  assert.equal(dl.headers.get('x-council-verdict-sha256'), contentSha256);
  assert.match(dl.headers.get('content-disposition') ?? '', new RegExp(`council-report-${sessionId}-r1\\.md`));
  assert.equal(dl.headers.get('cache-control'), 'no-cache');

  // T105: the Markdown carries the golden scores and the decision.
  assert.match(dl.text, /132/);
  assert.match(dl.text, /168/);
  assert.match(dl.text, /GO_WITH_CONDITIONS/);
  assert.match(dl.text, /AI perspective inspired by the published work of/);

  // The record JSON binds the same values plus sibling hashes and
  // the not-ready PDF entry.
  const recordCreated = await createExport(sessionId, { format: 'json' }, 'export-key-2');
  assert.equal(recordCreated.status, 201, JSON.stringify(recordCreated.body));
  const recordArtifact = recordCreated.body.data.artifacts[0];
  const recordDl = await download(recordArtifact.export_id);
  assert.equal(recordDl.status, 200);
  const record = JSON.parse(recordDl.text);
  assert.equal(record.report_revision_id, created.body.data.report_revision_id, 'one report revision across formats');
  assert.equal(record.verdict_block.content_sha256, contentSha256);
  const rowA = record.score_table.find((r: any) => r.option_id === 'A');
  const rowB = record.score_table.find((r: any) => r.option_id === 'B');
  assert.equal(rowA.weighted_sum, 132);
  assert.equal(rowA.score, 6);
  assert.equal(rowB.weighted_sum, 168);
  assert.equal(rowB.display_score, 7.6);
  assert.equal(rowB.spread, 3);
  const siblings = Object.fromEntries(record.sibling_artifacts.map((s: any) => [s.format, s]));
  assert.equal(siblings.markdown.sha256, artifact.sha256, 'the record binds the exact Markdown bytes');
  assert.equal(siblings.pdf.status, 'not_ready');
  assert.match(siblings.pdf.missing_piece, /CWE-044/);

  // Print HTML: same revision, print stylesheet present.
  const printCreated = await createExport(sessionId, { format: 'print_html' }, 'export-key-3');
  assert.equal(printCreated.status, 201, JSON.stringify(printCreated.body));
  const printDl = await download(printCreated.body.data.artifacts[0].export_id);
  assert.equal(printDl.status, 200);
  assert.match(printDl.text, /12\.5pt/);
  assert.match(printDl.text, /@page/);
  assert.match(printDl.text, /GO_WITH_CONDITIONS/);
});

test('PDF refuses EXPORT_FORMAT_NOT_READY naming the missing renderer; nothing is journaled', async () => {
  const sessionId = 'sess-export-2';
  seedSession(sessionId, 'company', null);
  commitCardsAndVerdict(sessionId, SCOPE);
  const before = exportJournalCount(sessionId);
  const pdf = await createExport(sessionId, { format: 'pdf' });
  assert.equal(pdf.status, 501, JSON.stringify(pdf.body));
  assert.equal(pdf.body.error.code, 'EXPORT_FORMAT_NOT_READY');
  assert.match(pdf.body.error.message, /Playwright\/Chromium/);
  const all = await createExport(sessionId, { format: 'all' });
  assert.equal(all.status, 501, JSON.stringify(all.body));
  assert.equal(all.body.error.code, 'EXPORT_FORMAT_NOT_READY');
  assert.equal(exportJournalCount(sessionId), before, 'no export was journaled for a refused format');
});

test('replay returns the recorded export with no second journal record; a changed payload under the same key conflicts (T078)', async () => {
  const sessionId = 'sess-export-3';
  seedSession(sessionId, 'company', null);
  commitCardsAndVerdict(sessionId, SCOPE);
  const first = await createExport(sessionId, { format: 'markdown' }, 'replay-key-1');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const countAfterFirst = exportJournalCount(sessionId);
  const replay = await createExport(sessionId, { format: 'markdown' }, 'replay-key-1');
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  assert.equal(replay.body.data.artifacts[0].export_id, first.body.data.artifacts[0].export_id);
  assert.equal(exportJournalCount(sessionId), countAfterFirst, 'the replay wrote no second journal record');

  const conflict = await createExport(sessionId, { format: 'json' }, 'replay-key-1');
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('T059: deleting the session between create and download refuses the download; a private export is owner-only', async () => {
  const sessionId = 'sess-export-4';
  seedSession(sessionId, 'company', null);
  commitCardsAndVerdict(sessionId, SCOPE);
  const created = await createExport(sessionId, { format: 'markdown' }, 'export-key-del');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const exportId = created.body.data.artifacts[0].export_id as string;
  const ok = await download(exportId);
  assert.equal(ok.status, 200);

  installFixtureEnv();
  const deleted = await sessionRoute.DELETE(
    await makeRequest('council-a.test', ALICE, `/api/council/sessions/${sessionId}`, {
      method: 'DELETE',
      csrf: true,
      idempotencyKey: `del-${Math.random()}`,
      body: { confirm: true },
    }),
    { params: Promise.resolve({ id: sessionId }) },
  );
  assert.equal(deleted.status, 200);
  // T059's invariant is non-exposure. A completed Section 16.5
  // deletion cascades from council_sessions to council_events, so
  // the export record is purged with the session and the download
  // refuses EXPORT_DELIVERABLE_NOT_FOUND with no artifact bytes.
  const refused = await download(exportId);
  assert.equal(refused.status, 404, refused.text.slice(0, 300));
  assert.match(refused.text, /EXPORT_DELIVERABLE_NOT_FOUND/);
  assert.ok(!refused.text.includes('Decision Report'), 'no artifact bytes survive deletion');

  // The race itself (deletion landing between locate and read) is
  // guarded inside readCouncilExport: a tombstone present while the
  // record still exists refuses EXPORT_SESSION_DELETED (410).
  const raceId = 'sess-export-6';
  seedSession(raceId, 'company', null);
  commitCardsAndVerdict(raceId, SCOPE);
  const raceCreated = await createExport(raceId, { format: 'markdown' }, 'export-key-race');
  assert.equal(raceCreated.status, 201, JSON.stringify(raceCreated.body));
  const raceExportId = raceCreated.body.data.artifacts[0].export_id as string;
  db.prepare(
    `INSERT INTO council_request_keys
       (tenant_id, source, operation, request_key, payload_fingerprint, session_id, created_at)
     VALUES ('tenant-a', 'council-persistence', 'session_deleted', ?, 'race-fixture', ?, ?)`,
  ).run(raceId, raceId, new Date().toISOString());
  const { readCouncilExport } = await import('../../src/lib/council/report-downloads');
  const raceEnvelope = envelopeFromScopeFn(SCOPE as never, ALICE, 'owner', 'read');
  assert.throws(
    () => readCouncilExport({ repositories, store: { handle: () => db } as never }, raceEnvelope, raceId, raceExportId),
    (error: any) => error?.code === 'EXPORT_SESSION_DELETED' && error?.status === 410,
  );

  // Private session: the owner exports; a same-company non-owner
  // cannot download.
  const privateId = 'sess-export-5';
  seedSession(privateId, 'private', ALICE);
  commitCardsAndVerdict(privateId, { ...SCOPE, owner_subject: ALICE });
  const privateCreated = await createExport(privateId, { format: 'markdown' }, 'export-key-priv');
  assert.equal(privateCreated.status, 201, JSON.stringify(privateCreated.body));
  const privateExportId = privateCreated.body.data.artifacts[0].export_id as string;
  const ownerDl = await download(privateExportId, ALICE);
  assert.equal(ownerDl.status, 200);
  assert.equal(ownerDl.headers.get('cache-control'), 'private, no-store');
  const bobDl = await download(privateExportId, BOB);
  assert.notEqual(bobDl.status, 200, 'a non-owner never receives private export bytes');
  assert.ok(!bobDl.text.includes('Decision Report'), 'no report bytes leak to the non-owner');
});
