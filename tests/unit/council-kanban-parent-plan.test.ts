/**
 * CWE-035 parent-and-plan service tests (directive Sections 17.6, 19,
 * 25; Section 35 contracts T020, T085, T086, T087, T088, T089).
 *
 * Exercised against the REAL host surface on an isolated database:
 * createTaskCore + taskRequestFingerprint idempotency, the actual
 * dispatch path (autoDispatchTask, the intake-advance normalizer, the
 * dispatch-intent sweep), task-lifecycle transition(), the CWE-006
 * repositories and hash-chained journal, and the CWE-007 assertions.
 */
import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
delete process.env.OPENAI_API_KEY;

import type { ActionProposal, Verdict } from '../../src/lib/council/contracts';
import type { CouncilPrincipal } from '../../src/lib/council/auth';
import type {
  CouncilRepositories,
  CouncilStoredSession,
} from '../../src/lib/council/store';
import type { CanonicalParentTaskAdapter } from '../../src/lib/council/kanban/parent-task';
import type { CouncilActionPlanService } from '../../src/lib/council/kanban/plan-service';

type Db = import('better-sqlite3').Database;

let db: Db;
let repositories: CouncilRepositories;
let parentAdapter: CanonicalParentTaskAdapter;
let planService: CouncilActionPlanService;
let Kanban: typeof import('../../src/lib/council/kanban/index');
let Auth: typeof import('../../src/lib/council/auth');
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let SCHEMA_VERSIONS: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let autoDispatchTaskFn: typeof import('../../src/lib/task-dispatcher').autoDispatchTask;
let normalizeIntakeForDispatchFn: typeof import('../../src/lib/jobs/intake-advance-sweep').normalizeIntakeForDispatch;
let runDispatchIntentSweepFn: typeof import('../../src/lib/jobs/dispatch-intents').runDispatchIntentSweep;
let closeDbFn: () => void;

const OWNER = 'owner-1';

function principal(
  subject: string,
  overrides: Partial<CouncilPrincipal> = {},
): CouncilPrincipal {
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
    ...overrides,
  } as CouncilPrincipal;
}

function makeStoredSession(
  sessionId: string,
  opts: { visibility?: 'company' | 'private'; ownerSubject?: string | null } = {},
): CouncilStoredSession {
  const spec = JSON.parse(JSON.stringify(fixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(fixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.visibility = opts.visibility ?? 'company';
  spec.brief_sha256 = canonicalHashFn(brief);
  const stored: CouncilStoredSession = {
    spec,
    brief,
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: 'inst-a',
      owner_subject: opts.ownerSubject ?? null,
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
    source_condition_ids: ['con-1'],
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

function makeVerdict(session: CouncilStoredSession, actions: ActionProposal[]): Verdict {
  const base = {
    schema_version: SCHEMA_VERSIONS.verdict,
    result_kind: 'scored' as const,
    session_id: session.spec.session_id,
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
    action_proposals: actions,
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

function taskRow(taskId: string) {
  return db
    .prepare(
      `SELECT id, title, description, status, source, sop_id, parent_task_id,
              assigned_agent_id, dispatch_hold, routing_reason, routing_wait_owner
         FROM tasks WHERE id = ?`,
    )
    .get(taskId) as Record<string, unknown> | undefined;
}

function tasksTaggedWith(sessionId: string): Array<Record<string, unknown>> {
  return db
    .prepare(`SELECT id, title, status FROM tasks WHERE description LIKE ?`)
    .all(`%[council-source-session:${sessionId}]%`) as Array<Record<string, unknown>>;
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
  Auth = await import('../../src/lib/council/auth');
  Kanban = await import('../../src/lib/council/kanban/index');
  const parentModule = await import('../../src/lib/council/kanban/parent-task');
  const planModule = await import('../../src/lib/council/kanban/plan-service');
  parentAdapter = new parentModule.CanonicalParentTaskAdapter({ repositories, db });
  planService = new planModule.CouncilActionPlanService({ repositories, db, parentAdapter });
  autoDispatchTaskFn = (await import('../../src/lib/task-dispatcher')).autoDispatchTask;
  normalizeIntakeForDispatchFn = (await import('../../src/lib/jobs/intake-advance-sweep')).normalizeIntakeForDispatch;
  runDispatchIntentSweepFn = (await import('../../src/lib/jobs/dispatch-intents')).runDispatchIntentSweep;

  const now = new Date().toISOString();
  const seedCompany = db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  );
  seedCompany.run('company-a', 'Company A', 'company-a', now, now);
  seedCompany.run('company-b', 'Company B', 'company-b', now, now);
});

after(() => {
  closeDbFn();
});

test('T086: governance registration is a real, idempotent registry write', async () => {
  const first = Kanban.ensureCouncilGovernance(db);
  const second = Kanban.ensureCouncilGovernance(db);
  assert.equal(first.sop.slug, 'council-deliberation');
  assert.equal(first.sop.created, true);
  assert.equal(second.sop.sop_id, first.sop.sop_id);
  assert.equal(second.sop.created, false);
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM sops WHERE slug = 'council-deliberation'`)
    .get() as { n: number };
  assert.equal(count.n, 1);
  assert.equal(first.persona.persona_id, 'council-chair-governance');
  assert.equal(typeof first.persona.registered, 'boolean');
});

test('T085: exactly one parent per company session across repeat and concurrent calls', async () => {
  const session = makeStoredSession('sess-parent-1');
  const owner = principal(OWNER);

  const first = await parentAdapter.ensureParentTask(owner, session.spec.session_id);
  assert.equal(first.kind, 'linked');
  if (first.kind !== 'linked') return;
  assert.equal(first.created, true);
  assert.equal(
    first.title,
    'Council review: Should we pilot the revised offer before a broad launch?',
  );
  const row = taskRow(first.task_id);
  assert.ok(row);
  assert.equal(row.status, 'backlog');
  assert.equal(row.source, 'council');
  assert.equal(row.dispatch_hold, 1);
  assert.equal(row.routing_reason, 'council_plan_assembling');
  assert.equal(row.assigned_agent_id, null);
  assert.match(String(row.description), /Handler: council_session/);
  assert.match(String(row.description), /\[council-source-session:sess-parent-1\]/);

  const again = await parentAdapter.ensureParentTask(owner, session.spec.session_id);
  assert.equal(again.kind, 'linked');
  if (again.kind === 'linked') {
    assert.equal(again.task_id, first.task_id);
    assert.equal(again.created, false);
  }

  const concurrentSession = makeStoredSession('sess-parent-concurrent');
  const results = await Promise.all([
    parentAdapter.ensureParentTask(owner, concurrentSession.spec.session_id),
    parentAdapter.ensureParentTask(owner, concurrentSession.spec.session_id),
    parentAdapter.ensureParentTask(owner, concurrentSession.spec.session_id),
  ]);
  const ids = new Set(results.map((r) => (r.kind === 'linked' ? r.task_id : 'none')));
  assert.equal(ids.size, 1);
  assert.equal(tasksTaggedWith('sess-parent-concurrent').length, 1);
  const links = db
    .prepare(
      `SELECT COUNT(*) AS n FROM council_kanban_links WHERE session_id = 'sess-parent-concurrent'`,
    )
    .get() as { n: number };
  assert.equal(links.n, 1);
});

test('T086 (parent side): the parent task carries the registered Council deliberation SOP id', async () => {
  const registration = Kanban.ensureCouncilGovernance(db);
  const owner = principal(OWNER);
  const ensured = await parentAdapter.ensureParentTask(owner, 'sess-parent-1');
  assert.equal(ensured.kind, 'linked');
  if (ensured.kind !== 'linked') return;
  assert.equal(taskRow(ensured.task_id)?.sop_id, registration.sop.sop_id);
});

test('T020: a private session creates no board task at all', async () => {
  makeStoredSession('sess-private-1', { visibility: 'private', ownerSubject: OWNER });
  const owner = principal(OWNER);
  const result = await parentAdapter.ensureParentTask(owner, 'sess-private-1');
  assert.deepEqual(result, { kind: 'none', reason: 'private_session' });
  assert.equal(tasksTaggedWith('sess-private-1').length, 0);
  const links = db
    .prepare(`SELECT COUNT(*) AS n FROM council_kanban_links WHERE session_id = 'sess-private-1'`)
    .get() as { n: number };
  assert.equal(links.n, 0);

  // A private session still plans (same approval mechanics), it just
  // never touches the board: materialization refuses with a typed none.
  const session = repositories.getSession(
    envelopeFromScopeFn(
      { tenant_id: 'tenant-a', company_id: 'company-a', installation_id: 'inst-a', owner_subject: OWNER },
      OWNER,
      'owner',
      'read',
    ),
    'sess-private-1',
  );
  assert.ok(session);
  const verdict = makeVerdict(session, [makeAction('sess-private-1', 'act-private-1')]);
  const plan = await planService.proposePlan(owner, 'sess-private-1', verdict);
  const decided = await planService.decidePlanItem(owner, 'sess-private-1', plan.plan_id, 'act-private-1', 'approved');
  assert.equal(decided.plan.status, 'approved');
  const materialized = await planService.materializePlanTasks(owner, 'sess-private-1', plan.plan_id);
  assert.deepEqual(materialized, { kind: 'not_materialized', reason: 'private_session' });
  assert.equal(tasksTaggedWith('sess-private-1').length, 0);
});

test('cross-scope attempts are refused and create nothing', async () => {
  const otherCompany = principal(OWNER, {
    scope: { tenant_id: 'tenant-a', company_id: 'company-b', installation_id: 'inst-a', owner_subject: null },
    tenant: {
      tenantId: 'tenant-a', companyId: 'company-b', clientId: 'client-b', kind: 'client',
      subject: OWNER, host: 'council-b.test', installationId: 'inst-a',
    },
  });
  await assert.rejects(
    parentAdapter.ensureParentTask(otherCompany, 'sess-parent-1'),
    (err: unknown) => err instanceof Kanban.CouncilKanbanError && err.code === 'COUNCIL_SESSION_NOT_FOUND',
  );

  const otherInstall = principal(OWNER, {
    scope: { tenant_id: 'tenant-a', company_id: 'company-a', installation_id: 'inst-b', owner_subject: null },
    tenant: {
      tenantId: 'tenant-a', companyId: 'company-a', clientId: 'client-a', kind: 'client',
      subject: OWNER, host: 'council-a.test', installationId: 'inst-b',
    },
  });
  await assert.rejects(
    parentAdapter.ensureParentTask(otherInstall, 'sess-parent-1'),
    (err: unknown) => err instanceof Auth.CouncilAuthError && err.code === 'COUNCIL_CROSS_SCOPE',
  );

  const stranger = principal('owner-2');
  await assert.rejects(
    parentAdapter.ensureParentTask(stranger, 'sess-private-1'),
    (err: unknown) => err instanceof Auth.CouncilAuthError && err.code === 'COUNCIL_PRIVATE_OWNER_REQUIRED',
  );
});

test('machine principals need a binding containing the exact permission (Section 25 separation)', async () => {
  const machine = principal('operator:api', { channel: 'machine' });
  await assert.rejects(
    parentAdapter.ensureParentTask(machine, 'sess-parent-1'),
    (err: unknown) => err instanceof Auth.CouncilAuthError && err.code === 'COUNCIL_MACHINE_BINDING',
  );
  const headers = new Headers({ 'x-expected-installation-id': 'inst-a' });
  const readOnlyBinding = {
    installation_id: 'inst-a',
    company_id: 'company-a',
    operations: ['read'] as const,
  };
  await assert.rejects(
    parentAdapter.ensureParentTask(machine, 'sess-parent-1', {
      machineBinding: readOnlyBinding,
      headers,
    }),
    (err: unknown) => err instanceof Auth.CouncilAuthError && err.code === 'COUNCIL_MACHINE_BINDING',
  );
  const createBinding = {
    installation_id: 'inst-a',
    company_id: 'company-a',
    operations: ['create_tasks'] as const,
  };
  const ok = await parentAdapter.ensureParentTask(machine, 'sess-parent-1', {
    machineBinding: createBinding,
    headers,
  });
  assert.equal(ok.kind, 'linked');
});

test('T089 + transitions: projection walks only legal transition() steps and the evidence gate holds', async () => {
  const owner = principal(OWNER);
  makeStoredSession('sess-projection-1');
  const deliberating = await parentAdapter.projectParentPhase(owner, 'sess-projection-1', 'deliberating');
  assert.equal(deliberating.kind, 'projected');
  if (deliberating.kind !== 'projected') return;
  assert.equal(deliberating.status, 'in_progress');
  assert.equal(taskRow(deliberating.task_id)?.status, 'in_progress');
  // The hold survives projection: the parent is worked by the council
  // service, never by a dispatched agent.
  assert.equal(taskRow(deliberating.task_id)?.dispatch_hold, 1);
  assert.equal(taskRow(deliberating.task_id)?.assigned_agent_id, null);

  const verdictStage = await parentAdapter.projectParentPhase(owner, 'sess-projection-1', 'verdict_validated');
  assert.equal(verdictStage.kind, 'blocked');
  if (verdictStage.kind === 'blocked') {
    assert.equal(verdictStage.reason, 'completion_evidence_required');
    assert.equal(verdictStage.status, 'in_progress');
  }
  assert.equal(taskRow(deliberating.task_id)?.status, 'in_progress');

  // Done is gated the same way (its path passes through Review): the
  // assignment override used for In Progress cannot waive it.
  const deliveredStage = await parentAdapter.projectParentPhase(owner, 'sess-projection-1', 'advisory_delivered');
  assert.equal(deliveredStage.kind, 'blocked');
  if (deliveredStage.kind === 'blocked') {
    assert.equal(deliveredStage.reason, 'completion_evidence_required');
  }
  assert.equal(taskRow(deliberating.task_id)?.status, 'in_progress');

  // A fresh adapter over the same store sees the identical held state:
  // the hold is persisted board state, not in-memory bookkeeping.
  const rebuilt = new Kanban.CanonicalParentTaskAdapter({ repositories, db });
  const view = await rebuilt.getParentTask(owner, 'sess-projection-1');
  assert.equal(view.kind, 'linked');
  if (view.kind === 'linked') {
    assert.equal(view.task_id, deliberating.task_id);
    assert.equal(taskRow(view.task_id)?.dispatch_hold, 1);
    assert.equal(taskRow(view.task_id)?.status, 'in_progress');
  }
});

test('plan lifecycle: propose, per-item approval binding, revision invalidation, materialize, barrier, release', async () => {
  const owner = principal(OWNER);
  const session = makeStoredSession('sess-plan-1');
  const verdict = makeVerdict(session, [
    makeAction('sess-plan-1', 'act-1'),
    makeAction('sess-plan-1', 'act-2'),
  ]);

  const plan = await planService.proposePlan(owner, 'sess-plan-1', verdict);
  assert.equal(plan.status, 'proposed');
  assert.equal(plan.items.length, 2);
  assert.equal(plan.required_execution_grant.kind, 'execution');
  assert.equal(plan.required_execution_grant.operation_ids.length, 2);
  assert.match(
    plan.required_execution_grant.operation_ids[0],
    /^council:sess-plan-1:verdict:1:action:act-1:plan:[0-9a-f]{64}$/,
  );
  const reproposed = await planService.proposePlan(owner, 'sess-plan-1', verdict);
  assert.equal(reproposed.plan_id, plan.plan_id);

  // Materialize before full approval: refused.
  await assert.rejects(
    planService.materializePlanTasks(owner, 'sess-plan-1', plan.plan_id),
    (err: unknown) => err instanceof Kanban.CouncilKanbanError && err.code === 'COUNCIL_PLAN_NOT_FULLY_APPROVED',
  );

  // Approve item 1 only: plan not complete, item 2 uncovered.
  const afterOne = await planService.decidePlanItem(owner, 'sess-plan-1', plan.plan_id, 'act-1', 'approved');
  assert.equal(afterOne.plan.status, 'proposed');
  assert.equal(afterOne.coverage.complete, false);
  assert.equal(afterOne.coverage.items.find((i) => i.action_id === 'act-1')?.covered, true);
  assert.equal(afterOne.coverage.items.find((i) => i.action_id === 'act-2')?.covered, false);
  assert.equal(afterOne.coverage.items.find((i) => i.action_id === 'act-1')?.item_revision, 1);

  // Approve item 2: plan becomes approved.
  const afterTwo = await planService.decidePlanItem(owner, 'sess-plan-1', plan.plan_id, 'act-2', 'approved');
  assert.equal(afterTwo.plan.status, 'approved');
  assert.equal(afterTwo.coverage.complete, true);

  // Edit item 1: the plan is superseded, revision 2 is bound, and the
  // revision-1 approval no longer covers anything on the new plan.
  const revised = await planService.revisePlanItem(owner, 'sess-plan-1', plan.plan_id, 'act-1', {
    title: 'Carry out act-1 with a narrower pilot',
  });
  assert.notEqual(revised.plan_id, plan.plan_id);
  assert.equal(revised.supersedes_id, plan.plan_id);
  assert.equal(revised.items.find((i) => i.action_id === 'act-1')?.item_revision, 2);
  const oldPlan = await planService.getPlan(owner, 'sess-plan-1', plan.plan_id);
  assert.equal(oldPlan.plan.status, 'superseded');
  await assert.rejects(
    planService.decidePlanItem(owner, 'sess-plan-1', plan.plan_id, 'act-1', 'approved'),
    (err: unknown) => err instanceof Kanban.CouncilKanbanError && err.code === 'COUNCIL_PLAN_SUPERSEDED',
  );
  const revisedView = await planService.getPlan(owner, 'sess-plan-1', revised.plan_id);
  assert.equal(revisedView.coverage.complete, false);
  assert.equal(
    revisedView.coverage.items.find((i) => i.action_id === 'act-1')?.covered,
    false,
  );

  // Re-approve both items on the revised plan.
  await planService.decidePlanItem(owner, 'sess-plan-1', revised.plan_id, 'act-1', 'approved');
  const approved = await planService.decidePlanItem(owner, 'sess-plan-1', revised.plan_id, 'act-2', 'approved');
  assert.equal(approved.plan.status, 'approved');

  // Release before any run grant resolves: not releasable, nothing moves.
  const evaluation = await planService.evaluatePlanRelease(owner, 'sess-plan-1', revised.plan_id);
  assert.equal(evaluation.releasable, false);
  assert.equal(evaluation.conditions.plan_fully_approved, true);
  assert.equal(evaluation.conditions.run_grant_active, false);
  assert.equal(evaluation.conditions.run_grant_status, 'missing');
  const releaseAttempt = await planService.releasePlan(owner, 'sess-plan-1', revised.plan_id);
  assert.equal(releaseAttempt.released, false);

  // Materialize: children are born held, tagged, and linked to the parent.
  const materialized = await planService.materializePlanTasks(owner, 'sess-plan-1', revised.plan_id);
  assert.equal(materialized.kind, 'materialized');
  if (materialized.kind !== 'materialized') return;
  assert.equal(materialized.links.length, 2);
  const parentRow = taskRow(materialized.parent_task_id);
  assert.ok(parentRow);
  for (const link of materialized.links) {
    const child = taskRow(link.task_id);
    assert.ok(child, `child task ${link.task_id} exists`);
    assert.equal(child.status, 'backlog');
    assert.equal(child.source, 'council');
    assert.equal(child.parent_task_id, materialized.parent_task_id);
    assert.equal(child.dispatch_hold, 1);
    assert.equal(child.routing_reason, 'council_plan_assembling');
    assert.equal(child.assigned_agent_id, null);
    assert.match(String(child.description), /\[council-source-session:sess-plan-1\]/);
    const childShape = child as unknown as { source?: string | null; description?: string | null };
    assert.equal(Kanban.isCouncilGeneratedTask(childShape), true);
    assert.equal(Kanban.councilSessionIdFromTask(childShape), 'sess-plan-1');
  }
  const linkRows = db
    .prepare(`SELECT COUNT(*) AS n FROM council_task_links WHERE session_id = 'sess-plan-1'`)
    .get() as { n: number };
  assert.equal(linkRows.n, 2);

  // Materialize again: idempotent, no duplicates.
  const rematerialized = await planService.materializePlanTasks(owner, 'sess-plan-1', revised.plan_id);
  assert.equal(rematerialized.kind, 'materialized');
  if (rematerialized.kind === 'materialized') {
    assert.deepEqual(
      rematerialized.links.map((l) => l.task_id).sort(),
      materialized.links.map((l) => l.task_id).sort(),
    );
    assert.ok(rematerialized.links.every((l) => l.created === false));
  }
  assert.equal(tasksTaggedWith('sess-plan-1').length, 3); // parent + 2 children

  // T087/T088 barrier: the REAL dispatch path cannot move a held task.
  const childId = materialized.links[0].task_id;
  const outcome = await autoDispatchTaskFn(childId, 'council-kanban-test');
  assert.equal(outcome.status, 'held');
  assert.equal(normalizeIntakeForDispatchFn(childId), false);
  const sweep = await runDispatchIntentSweepFn();
  assert.equal(sweep.acknowledged, 0);
  const executions = db
    .prepare(`SELECT COUNT(*) AS n FROM task_executions WHERE task_id = ?`)
    .get(childId) as { n: number };
  assert.equal(executions.n, 0);
  const after = taskRow(childId);
  assert.equal(after?.status, 'backlog');
  assert.equal(after?.dispatch_hold, 1);
  assert.equal(after?.assigned_agent_id, null);

  // Release with an active grant through the Section 25.6 port: marks
  // the plan ready and changes NO task state.
  const grantingService = new Kanban.CouncilActionPlanService({
    repositories,
    db,
    parentAdapter,
    runAuthorization: {
      previewRun: async () => {
        throw new Error('not used');
      },
      approveRun: async () => {
        throw new Error('not used');
      },
      resolveRunGrant: async (input) => ({
        status: 'active' as const,
        grant_ref: 'grant-fixture-1',
        session_id: input.session_id,
        scope_sha256: 'f'.repeat(64),
      }),
      revokeRunGrant: async () => ({ revoked: false }),
      admitOperation: async () => ({ admitted: false }),
      recordConsumption: async () => ({ recorded: false }),
    },
  });
  const released = await grantingService.releasePlan(owner, 'sess-plan-1', revised.plan_id);
  assert.equal(released.released, true);
  assert.equal(released.evaluation.readiness, 'ready_for_execution_dispatch');
  assert.equal(released.evaluation.conditions.run_grant_ref, 'grant-fixture-1');
  const viewAfterRelease = await grantingService.getPlan(owner, 'sess-plan-1', revised.plan_id);
  assert.equal(viewAfterRelease.released?.grant_ref, 'grant-fixture-1');
  for (const link of materialized.links) {
    const child = taskRow(link.task_id);
    assert.equal(child?.status, 'backlog');
    assert.equal(child?.dispatch_hold, 1);
  }

  // The whole history verifies against the CWE-006 hash chain.
  const envelope = envelopeFromScopeFn(session.scope, OWNER, 'owner', 'read');
  const chain = repositories.verifyChain(envelope, 'sess-plan-1');
  assert.equal(chain.ok, true);
  assert.ok(chain.checked > 5);
});
