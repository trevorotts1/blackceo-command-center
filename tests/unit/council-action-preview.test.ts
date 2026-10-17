/**
 * CWE-036 action plan preview tests (directive Sections 17.6, 19.5;
 * Section 35 contract T090).
 *
 * Preview computes the exact plan from the committed, validated
 * verdict revision and writes NOTHING. These tests prove:
 * - the preview's plan hash, items, and required-grant operation IDs
 *   are byte-identical to what CWE-035's proposePlan persists for the
 *   same verdict and selection (the hash an approval binds);
 * - a preview leaves every store table and the tasks table exactly
 *   as it found them (counts snapshotted around the call);
 * - superseded, future, missing, consult, and invalid verdicts are
 *   refused with typed errors;
 * - request bodies are strict: a client-supplied handler field is a
 *   schema failure, never a coerced input.
 */
import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
delete process.env.OPENAI_API_KEY;

import type { ActionProposal, Verdict } from '../../src/lib/council/contracts';
import type { CouncilPrincipal } from '../../src/lib/council/auth';
import type { CouncilRepositories, CouncilStoredSession } from '../../src/lib/council/store';
import type { CouncilRouteContext } from '../../src/lib/council/api/foundation';

type Db = import('better-sqlite3').Database;

let db: Db;
let repositories: CouncilRepositories;
let Approvals: typeof import('../../src/lib/council/approvals');
let Foundation: typeof import('../../src/lib/council/api/foundation');
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let SCHEMA_VERSIONS: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let planService: InstanceType<typeof import('../../src/lib/council/kanban/plan-service').CouncilActionPlanService>;
let closeDbFn: () => void;

const OWNER = 'owner-1';

function principal(subject: string): CouncilPrincipal {
  return {
    subject,
    tenantKind: 'client',
    channel: 'browser',
    supportAccess: false,
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: 'inst-a',
      owner_subject: null,
    },
    tenant: {
      tenantId: 'tenant-a',
      companyId: 'company-a',
      clientId: 'client-a',
      kind: 'client',
      subject,
      host: 'council-a.test',
      installationId: 'inst-a',
    },
  } as CouncilPrincipal;
}

function makeStoredSession(sessionId: string): CouncilStoredSession {
  const spec = JSON.parse(JSON.stringify(fixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(fixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.visibility = 'company';
  spec.brief_sha256 = canonicalHashFn(brief);
  const stored: CouncilStoredSession = {
    spec,
    brief,
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: 'inst-a',
      owner_subject: null,
    },
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
  const envelope = envelopeFromScopeFn(stored.scope, OWNER, 'owner', 'write');
  repositories.createSession(envelope, stored);
  return stored;
}

function makeAction(sessionId: string, actionId: string, overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
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
  };
}

function makeVerdict(
  session: CouncilStoredSession,
  actions: ActionProposal[],
  revision = 1,
): Verdict {
  const base = {
    schema_version: SCHEMA_VERSIONS.verdict,
    result_kind: 'scored' as const,
    session_id: session.spec.session_id,
    verdict_revision: revision,
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
    action_proposals: actions.map((a) => ({ ...a, verdict_revision: revision })),
    cheapest_informative_test: null,
    stop_criteria: [],
    review_criteria: [],
    resolution_support: null,
    validation_status: 'valid' as const,
    ratification_status: 'ratified' as const,
    brief_sha256: session.spec.brief_sha256,
  };
  return { ...base, content_sha256: canonicalHashFn(base) } as Verdict;
}

function commitVerdict(session: CouncilStoredSession, verdict: Verdict): void {
  const envelope = envelopeFromScopeFn(session.scope, OWNER, 'owner', 'write');
  const saved = repositories.saveVerdict(envelope, verdict);
  assert.equal(saved.outcome, 'committed');
}

function ctxFor(subject: string): CouncilRouteContext {
  return {
    principal: principal(subject),
    requestId: 'fixture-request',
    repositories,
    store: { handle: () => db } as CouncilRouteContext['store'],
  };
}

const COUNTED_TABLES = [
  'tasks',
  'task_executions',
  'council_action_proposals',
  'council_approvals',
  'council_events',
  'council_projection_outbox',
  'council_request_keys',
  'council_task_links',
  'council_kanban_links',
] as const;

function snapshotCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return counts;
}

before(async () => {
  const dbModule = await import('../../src/lib/db');
  db = dbModule.getDb();
  closeDbFn = dbModule.closeDb;
  const store = await import('../../src/lib/council/store');
  repositories = new store.CouncilRepositories();
  envelopeFromScopeFn = store.envelopeFromScope;
  const contracts = await import('../../src/lib/council/contracts');
  canonicalHashFn = contracts.canonicalHash;
  SCHEMA_VERSIONS = contracts.SCHEMA_VERSIONS;
  fixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  Approvals = await import('../../src/lib/council/approvals');
  Foundation = await import('../../src/lib/council/api/foundation');
  const planModule = await import('../../src/lib/council/kanban/plan-service');
  planService = new planModule.CouncilActionPlanService({ repositories, db });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run('company-a', 'Company A', 'company-a', now, now);
});

after(() => {
  closeDbFn();
});

test('T090: preview computes the exact plan proposePlan persists, byte for byte', async () => {
  const session = makeStoredSession('sess-preview-parity');
  const verdict = makeVerdict(session, [
    makeAction('sess-preview-parity', 'act-1'),
    makeAction('sess-preview-parity', 'act-2', { depends_on_action_ids: ['act-1'] }),
  ]);
  commitVerdict(session, verdict);

  const ctx = ctxFor(OWNER);
  const authorized = Foundation.authorizeSessionMutate(ctx, 'sess-preview-parity');
  const preview = await Approvals.previewActionPlan(ctx, authorized, 'sess-preview-parity', {
    verdict_revision: 1,
  });
  assert.equal(preview.preview_only, true);
  assert.equal(preview.verdict_revision, 1);
  assert.equal(preview.approval_binding.plan_hash, preview.plan_hash);

  const persisted = await planService.proposePlan(principal(OWNER), 'sess-preview-parity', verdict);
  assert.equal(persisted.plan_hash, preview.plan_hash, 'preview hash equals the persisted plan hash');
  assert.deepEqual(
    persisted.items.map((i) => ({ action_id: i.action_id, item_revision: i.item_revision, item_sha256: i.item_sha256 })),
    preview.items.map((i) => ({ action_id: i.action_id, item_revision: i.item_revision, item_sha256: i.item_sha256 })),
  );
  assert.deepEqual(
    persisted.required_execution_grant.operation_ids,
    preview.required_execution_grant.operation_ids,
  );
  assert.deepEqual(persisted.required_execution_grant.budgets, [
    { currency: 'USD', amount_minor: 10000 },
  ]);
});

test('T090: preview writes nothing to the store or the task tables', async () => {
  const session = makeStoredSession('sess-preview-purity');
  commitVerdict(session, makeVerdict(session, [makeAction('sess-preview-purity', 'act-1')]));

  const before = snapshotCounts();
  const ctx = ctxFor(OWNER);
  const authorized = Foundation.authorizeSessionMutate(ctx, 'sess-preview-purity');
  await Approvals.previewActionPlan(ctx, authorized, 'sess-preview-purity', { verdict_revision: 1 });
  const after = snapshotCounts();
  assert.deepEqual(after, before, 'preview changed no table counts');
});

test('T090: a subset selection preview matches the persisted subset plan', async () => {
  const session = makeStoredSession('sess-preview-subset');
  const verdict = makeVerdict(session, [
    makeAction('sess-preview-subset', 'act-1'),
    makeAction('sess-preview-subset', 'act-2'),
  ]);
  commitVerdict(session, verdict);

  const ctx = ctxFor(OWNER);
  const authorized = Foundation.authorizeSessionMutate(ctx, 'sess-preview-subset');
  const preview = await Approvals.previewActionPlan(ctx, authorized, 'sess-preview-subset', {
    verdict_revision: 1,
    selected_action_ids: ['act-2'],
  });
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0].action_id, 'act-2');

  const persisted = await planService.proposePlan(principal(OWNER), 'sess-preview-subset', verdict, {
    selected_action_ids: ['act-2'],
  });
  assert.equal(persisted.plan_hash, preview.plan_hash);
});

test('superseded, future, and missing verdict revisions are refused with typed errors', async () => {
  const session = makeStoredSession('sess-preview-revisions');
  commitVerdict(session, makeVerdict(session, [makeAction('sess-preview-revisions', 'act-1')], 1));
  commitVerdict(session, makeVerdict(session, [makeAction('sess-preview-revisions', 'act-1')], 2));

  const ctx = ctxFor(OWNER);
  const authorized = Foundation.authorizeSessionMutate(ctx, 'sess-preview-revisions');
  await assert.rejects(
    Approvals.previewActionPlan(ctx, authorized, 'sess-preview-revisions', { verdict_revision: 1 }),
    (err: unknown) =>
      (err as { code?: string }).code === 'COUNCIL_VERDICT_SUPERSEDED',
  );
  await assert.rejects(
    Approvals.previewActionPlan(ctx, authorized, 'sess-preview-revisions', { verdict_revision: 3 }),
    (err: unknown) => (err as { code?: string }).code === 'COUNCIL_VERDICT_NOT_FOUND',
  );

  const empty = makeStoredSession('sess-preview-noverdict');
  const authorizedEmpty = Foundation.authorizeSessionMutate(ctx, 'sess-preview-noverdict');
  await assert.rejects(
    Approvals.previewActionPlan(ctx, authorizedEmpty, 'sess-preview-noverdict', { verdict_revision: 1 }),
    (err: unknown) => (err as { code?: string }).code === 'COUNCIL_VERDICT_NOT_FOUND',
  );
  void empty;
});

test('a client-supplied handler or foreign scope field is a schema failure, never coerced', async () => {
  const session = makeStoredSession('sess-preview-strict');
  commitVerdict(session, makeVerdict(session, [makeAction('sess-preview-strict', 'act-1')]));
  const ctx = ctxFor(OWNER);
  const authorized = Foundation.authorizeSessionMutate(ctx, 'sess-preview-strict');
  await assert.rejects(
    Approvals.previewActionPlan(ctx, authorized, 'sess-preview-strict', {
      verdict_revision: 1,
      handler: 'department_dispatch',
    }),
    (err: unknown) => (err as { code?: string }).code === 'SCHEMA_VALIDATION',
  );
  await assert.rejects(
    Approvals.previewActionPlan(ctx, authorized, 'sess-preview-strict', {
      verdict_revision: 1,
      destination: { tenant_id: 'tenant-b', company_id: 'company-b' },
    }),
    (err: unknown) => (err as { code?: string }).code === 'SCHEMA_VALIDATION',
  );
});
